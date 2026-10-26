/**
 * Modal Gateway — Extension JS pour ComfyUI
 * ==========================================
 * Ajoute un sélecteur de GPU et redirige "Queue Prompt" vers l'API Modal
 * quand le mode cloud est actif.
 *
 * Intégré au pack AI-Helper (js/comfych/modal_gateway.js, servi par le
 * WEB_DIRECTORY "js" du pack) :
 *  - le sélecteur n'est PLUS injecté dans la barre d'outils de ComfyUI ; il est
 *    monté dans le sous-menu « AIH ▾ → Outils & Dev → ComfyCH » via le pont
 *    window.AIHComfyCHHost (buildControls/openSettings) ;
 *  - le mode de rendu est FORCÉ à « local » au démarrage, EN MÉMOIRE : le
 *    serveur l'annonce par /api/modal/config (render_mode_forced) et RIEN
 *    n'est écrit (ni localStorage du GPU préféré, ni config.json) ;
 *  - l'interception de queuePrompt reste TOUJOURS en place : en mode local elle
 *    ne fait que déléguer à l'implémentation d'origine (aucun activer/désactiver).
 *
 * @version 1.0.0
 * @see https://github.com/caru-ini/modal-comfyui
 */

// ─── Dépendances du pack (imports ESM relatifs) ────────────────────────────
// Ce module est chargé comme module ES par le pack (js/comfych_gateway.js) :
//  - les icônes viennent de la FAÇADE du pack (js/aih_icons.js — jamais la
//    brique vendorisée directement, jamais d'emoji dans l'UI) ;
//  - la fenêtre de suivi de run utilise AIH.Dialog (js/aih_dialog.js, importé
//    par le chargeur AVANT ce module) : c'est la seule primitive de fenêtre du
//    pack, aucun second système de modale n'est créé ici.
import { aihIconSvg } from "../aih_icons.js";

(function () {
    'use strict';

    // ─── i18n ───────────────────────────────────────────────────────────────
    /**
     * Traduit une clé via AIH.I18n du pack, avec repli sur le texte FR fourni.
     *
     * ComfyCH est une copie INTÉGRÉE dont l'UI historique est en français : le
     * repli garde le module utilisable seul (aucune dépendance dure au pack).
     * Les libellés AJOUTÉS passent par les clés « comfych.run.* » de
     * js/aih_strings.js (parité FR/EN stricte).
     *
     * @param {string} key - Clé i18n.
     * @param {string} [fallback] - Texte français si la clé manque.
     * @param {object} [params] - Interpolation.
     * @returns {string}
     */
    function t(key, fallback, params) {
        var I18n = window.AIH && window.AIH.I18n;
        var value = (I18n && typeof I18n.t === 'function') ? I18n.t(key, params) : '';
        return (value && value !== key) ? value : (fallback || key);
    }

    // ─── Configuration ───────────────────────────────────────────────────────

    const CONFIG = {
        /**
         * URL de base de l'API Modal Gateway.
         * Chargée depuis localStorage ou l'API serveur.
         * @type {string}
         */
        API_URL: localStorage.getItem('modal-api-url') || '',

        /**
         * Clé API envoyée dans l'en-tête X-API-Key à l'API Modal Gateway.
         * Doit correspondre au Secret Modal "comfy-gateway-secret".
         * @type {string}
         */
        API_KEY: localStorage.getItem('modal-api-key') || '',

        /** Clé de stockage localStorage pour persister le choix du GPU. */
        STORAGE_KEY: 'modal-gateway-mode',

        /**
         * Timeout par défaut des requêtes vers Modal (en ms).
         * 11 min : doit rester AU-DESSUS du budget de polling serveur
         * (600 s dans gateway_router.py) pour que le serveur puisse répondre
         * une erreur propre (504) avant que le navigateur n'abandonne.
         * Surchargeable : localStorage.setItem('modal-timeout-ms', '900000').
         */
        TIMEOUT_MS: parseInt(localStorage.getItem('modal-timeout-ms'), 10) || 660000,

        /** Intervalle entre les tentatives d'interception de l'API (en ms). */
        RETRY_INTERVAL: 800,

        /** Nombre maximum de tentatives d'interception. */
        MAX_RETRIES: 20,

    };

    // ─── Mode de rendu : ÉTAT EN MÉMOIRE (jamais forcé dans un fichier) ────
    // Valeur effective lue par l'interception de queuePrompt. Elle démarre
    // TOUJOURS à « local » : au pire, un workflow part en local avant que la
    // config serveur n'ait répondu. Le mode enregistré n'est adopté que si le
    // serveur ne force rien (render_mode_forced vide).
    var runtimeMode = 'local';

    /** Le mode de rendu courant (« local » ou « modal:<gpu> »). */
    function currentRenderMode() {
        return runtimeMode || 'local';
    }

    /**
     * Applique le mode de rendu issu de la config serveur.
     *
     * - render_mode_forced non vide → ce mode GAGNE, en mémoire seulement
     *   (aucun localStorage ni config.json touché : le GPU préféré de
     *   l'utilisateur reste intact et redeviendra actif quand le forçage sera
     *   retiré) ;
     * - sinon → préférence habituelle (localStorage).
     *
     * @param {object} config - Réponse de /api/modal/config.
     */
    function applyRenderModeFromServer(config) {
        var forced = config && typeof config.render_mode_forced === 'string'
            ? config.render_mode_forced
            : '';
        if (forced) {
            runtimeMode = forced;
            console.info('Modal Gateway: mode de rendu forcé par le serveur =', forced,
                '(forçage EN MÉMOIRE : préférence enregistrée non modifiée)');
            return;
        }
        var saved = localStorage.getItem(CONFIG.STORAGE_KEY);
        if (saved) runtimeMode = saved;
    }

    // ─── Chargement de la config depuis le serveur au démarrage ────────────

    fetch('/api/modal/config')
        .then(function (r) { return r.json(); })
        .then(function (config) {
            // La clé n'est plus transmise en clair par le serveur : on ne
            // mémorise que sa présence (voir F3, __init__.py).
            window._apiKeySet = !!config.api_key_set;
            if (config.api_url) {
                CONFIG.API_URL = config.api_url;
                localStorage.setItem('modal-api-url', config.api_url);
            }
            if (config.api_key) {
                CONFIG.API_KEY = config.api_key;
                localStorage.setItem('modal-api-key', config.api_key);
            }
            // Mode de rendu : forçage serveur (en mémoire) sinon préférence locale.
            applyRenderModeFromServer(config);
            // Prévenir le sous-menu AIH (s'il est déjà monté) que les contrôles
            // sont disponibles : il rebâtira sa ligne à la prochaine ouverture.
            if (window.AIHComfyCHHost && typeof window.AIHComfyCHHost.onReady === 'function') {
                window.AIHComfyCHHost.onReady();
            }

        })
        .catch(function () {
            // Mode dégradé : utiliser les valeurs par défaut (vides ou localStorage)
            // L'utilisateur devra configurer via la modale
        });

    // ─── Render Queue ──────────────────────────────────────────────────────

    var RenderQueue = {
        items: [],
        activeCount: 0,
        maxConcurrent: 1,
        nextId: 1,
        processing: false,

        /** Génère un identifiant unique par rendu (idempotence côté serveur). */
        _newRequestId: function () {
            return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 10);
        },

        enqueue: function (number, workflow, options, gpu) {
            var self = this;
            // Deep clone workflow — ComfyUI may mutate it after queuePrompt returns
            var clonedWorkflow = JSON.parse(JSON.stringify(workflow));

            var item = {
                id: self.nextId++,
                number: number,
                workflow: clonedWorkflow,
                options: options,
                gpu: gpu,
                requestId: self._newRequestId(),
                status: 'pending',
                error: null,
                addedAt: Date.now(),
            };

            var promise = new Promise(function (resolve, reject) {
                item.resolve = resolve;
                item.reject = reject;
            });

            self.items.push(item);
            self.updateUI();
            self.process();
            return promise;
        },

        process: function () {
            var self = this;
            if (self.processing || self.activeCount >= self.maxConcurrent) return;

            var next = null;
            for (var i = 0; i < self.items.length; i++) {
                if (self.items[i].status === 'pending') {
                    next = self.items[i];
                    break;
                }
            }
            if (!next) return;

            next.status = 'processing';
            self.activeCount++;
            self.processing = true;
            self.updateUI();

            executeCloudRender(next)
                .then(function (result) {
                    next.status = 'completed';
                    next.resolve(result);
                })
                .catch(function (err) {
                    var message = (err && err.message) || 'Unknown error';
                    // Un item annulé pendant l'exécution garde son état propre :
                    // l'UI distingue nettement échec / annulation / succès.
                    if (next.status === 'cancelled' || next.cancelled) {
                        next.status = 'cancelled';
                        next.error = next.error || t('comfych.run.cancelledByUser', 'Annulé par l\'utilisateur');
                        RunMonitor.finish('cancelled', next.error);
                    } else {
                        next.status = 'failed';
                        next.error = message;
                        // Le suivi de run reste lisible APRÈS l'échec : statut,
                        // log complet et bouton « Copier l'erreur ».
                        RunMonitor.finish('failed', message);
                    }
                    next.reject(err);
                    showNotification(
                        next.status === 'cancelled'
                            ? t('comfych.run.notifyCancelled', 'Render #{id} annulé.', { id: next.id })
                            : t('comfych.run.notifyFailed', 'Render #{id} échoué : {message}', {
                                id: next.id,
                                message: String(next.error || '').substring(0, 80),
                            }),
                        next.status === 'cancelled' ? 'info' : 'error'
                    );
                })
                .then(function () {
                    self.activeCount--;
                    self.processing = false;
                    self.updateUI();
                    // Clean up old completed/failed items (keep last 50) —
                    // sans dupliquer les items actifs encore dans les 50 derniers
                    if (self.items.length > 50) {
                        var activeItems = self.items.filter(function (i) {
                            return i.status === 'pending' || i.status === 'processing';
                        });
                        var activeIds = {};
                        for (var ai = 0; ai < activeItems.length; ai++) {
                            activeIds[activeItems[ai].id] = true;
                        }
                        var recentCompleted = self.items.slice(-50).filter(function (i) {
                            return !activeIds[i.id];
                        });
                        self.items = activeItems.concat(recentCompleted);
                    }
                    self.process();
                });
        },

        /**
         * Recompte les items par état (source unique des compteurs affichés).
         * @returns {{pending:number, processing:number, failed:number, cancelled:number, total:number}}
         */
        counts: function () {
            var counts = { pending: 0, processing: 0, failed: 0, cancelled: 0, total: 0 };
            for (var i = 0; i < this.items.length; i++) {
                var s = this.items[i].status;
                if (s === 'pending') counts.pending++;
                else if (s === 'processing') counts.processing++;
                else if (s === 'failed') counts.failed++;
                else if (s === 'cancelled') counts.cancelled++;
            }
            counts.total = this.items.length;
            return counts;
        },

        updateUI: function () {
            var badge = document.getElementById('modal-queue-badge');
            if (!badge) return;

            var counts = this.counts();
            var active = counts.pending + counts.processing;
            // L'indicateur reste visible tant qu'un run est SUIVI : il est le
            // point d'entrée de la fenêtre de suivi (rouvrable après la fin).
            var hasRun = RunMonitor.hasRun();
            if (active === 0 && !hasRun) {
                badge.style.display = 'none';
                return;
            }

            badge.style.display = 'inline-block';
            badge.title = t(
                'comfych.run.badgeTitle',
                'Ouvrir le suivi du run (ne bloque pas ComfyUI)'
            );
            var text = '';
            if (active > 0) {
                text = t('comfych.run.badgeQueue', 'File : {count}', { count: active });
                if (counts.processing > 0) {
                    text += ' · ' + runStatusLabel(RunMonitor.status);
                }
            } else {
                text = runStatusLabel(RunMonitor.status);
            }
            if (counts.failed > 0) {
                text += ' · ' + t('comfych.run.badgeFailed', '{count} en échec', {
                    count: counts.failed,
                });
            }
            badge.textContent = text;
            badge.style.borderColor = counts.failed > 0
                ? '#c0392b'
                : (active > 0 ? '#4a8a4a' : '#333');
        },

        /**
         * Annule les rendus EN ATTENTE (jamais le rendu en cours).
         *
         * État distinct (`cancelled`) : l'UI doit pouvoir distinguer une
         * annulation volontaire d'un échec du worker.
         */
        clearPending: function () {
            var cancelled = 0;
            for (var i = 0; i < this.items.length; i++) {
                if (this.items[i].status === 'pending') {
                    this.items[i].status = 'cancelled';
                    this.items[i].error = t('comfych.run.cancelledByUser', 'Annulé par l\'utilisateur');
                    this.items[i].reject(new Error('Cancelled by user'));
                    cancelled++;
                }
            }
            this.updateUI();
            RunMonitor.renderInfo();
            showNotification(
                cancelled > 0
                    ? t('comfych.run.queueCleared', '{count} rendu(s) en attente annulé(s)', {
                        count: cancelled,
                    })
                    : t('comfych.run.queueEmpty', 'Aucun rendu en attente'),
                'info'
            );
        },
    };

    /**
     * Options de GPU proposées dans le dropdown.
     * Chaque entrée : { value, label }.
     * - "local" = exécution locale (pas d'interception).
     * - "modal:<gpu>" = exécution sur le GPU Modal spécifié.
     */
    const GPU_OPTIONS = [
        { value: 'local', label: '🖥️  Local (gratuit)' },
        { value: 'modal:l4', label: '☁️  L4 — $0.80/h' },
        { value: 'modal:l40s', label: '☁️  L40S — $1.95/h' },
        { value: 'modal:a100', label: '☁️  A100 80GB — $2.50/h' },
        { value: 'modal:h100', label: '☁️  H100 — $3.95/h' },
    ];

    /** Variable pour stocker le GPU actif lors d'un envoi cloud. */
    var currentGpu = '';

    /**
     * Nom de l'extension enregistrée auprès de ComfyUI.
     * Utilisé par app.registerExtension().
     */
    const EXTENSION_NAME = 'Modal Gateway';

    /**
     * Flag indiquant si le dropdown a déjà été injecté dans la nouvelle barre d'outils.
     */
    var dropdownInjected = false;

    // ─── Helpers de transfert d'images ─────────────────────────────────────

    /**
     * Convertit un Blob en chaîne base64 (sans préfixe data:).
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
                var result = reader.result;
                // data:image/png;base64,XXXXX → XXXXX
                var comma = result.indexOf(',');
                resolve(comma >= 0 ? result.substring(comma + 1) : result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Scanne le workflow pour trouver les nodes LoadImage avec des fichiers
     * locaux, les charge depuis le serveur ComfyUI et les encode en base64
     * dans extra_data.images.
     *
     * Si une image encodée dépasse ~4 MB, on bascule vers l'upload direct
     * via /upload/image.
     *
     * @param {object} workflow - Le workflow JSON à enrichir.
     * @returns {Promise<object>} Le workflow enrichi (ou l'original inchangé).
     */
    async function encodeLocalImages(workflow) {
        var nodesWithImages = [];

        for (var nodeId in workflow) {
            if (Object.prototype.hasOwnProperty.call(workflow, nodeId)) {
                var node = workflow[nodeId];
                if (node.class_type === 'LoadImage' && node.inputs && node.inputs.image) {
                    var filename = node.inputs.image;
                    if (typeof filename === 'string' && !filename.startsWith('http')) {
                        nodesWithImages.push({ nodeId: nodeId, node: node, filename: filename });
                    }
                }
            }
        }

        if (nodesWithImages.length === 0) return workflow;

        var MAX_BASE64_SIZE = 4 * 1024 * 1024; // 4 MB

        for (var i = 0; i < nodesWithImages.length; i++) {
            var item = nodesWithImages[i];
            var nodeId = item.nodeId;
            var node = item.node;
            var filename = item.filename;

            try {
                var response = await fetch(
                    '/view?filename=' + encodeURIComponent(filename) + '&type=input&subfolder='
                );
                if (!response.ok) {
                    console.warn('Modal Gateway: fichier local introuvable:', filename);
                    continue;
                }

                var blob = await response.blob();
                var base64 = await blobToBase64(blob);

                if (base64.length > MAX_BASE64_SIZE) {
                    // Trop gros pour base64 → upload direct
                    console.warn('Modal Gateway: image trop grande pour base64, upload direct:', filename);
                    var uploadResult = await uploadImageDirectly(blob, filename);
                    if (uploadResult && uploadResult.name) {
                        node.inputs.image = uploadResult.name;
                    }
                } else {
                    // Encodage base64 dans extra_data
                    if (!workflow.extra_data) workflow.extra_data = {};
                    if (!workflow.extra_data.images) workflow.extra_data.images = [];
                    workflow.extra_data.images.push({
                        filename: filename,
                        subfolder: '',
                        type: 'input',
                        imagebase64: base64,
                    });
                    // On conserve le nom de fichier original comme référence
                    node.inputs.image = filename;
                }
            } catch (e) {
                console.warn('Modal Gateway: impossible de charger l\'image locale:', filename, e);
            }
        }

        return workflow;
    }

    /**
     * Upload direct d'une image (blob) vers l'endpoint /upload/image du worker Modal.
     * Utilisé en fallback quand l'image est trop grosse pour le base64.
     * @param {Blob} blob - Données binaires de l'image.
     * @param {string} filename - Nom de fichier original.
     * @returns {Promise<object>} Réponse JSON du serveur (contient .name).
     */
    async function uploadImageDirectly(blob, filename) {
        var formData = new FormData();
        formData.append('image', blob, filename);
        formData.append('overwrite', 'true');

        var gpuParam = currentGpu ? '?gpu=' + encodeURIComponent(currentGpu) : '';

        var response = await fetch(CONFIG.API_URL + '/upload/image' + gpuParam, {
            method: 'POST',
            headers: {
                'X-API-Key': CONFIG.API_KEY,
            },
            body: formData,
        });

        if (!response.ok) {
            var errText = '';
            try {
                var errJson = await response.json();
                errText = errJson.detail || errJson.error || JSON.stringify(errJson);
            } catch (_) {
                try { errText = await response.text(); } catch (_2) {}
            }
            throw new Error('Upload failed: HTTP ' + response.status + ' ' + errText);
        }

        return await response.json();
    }

    // ─── Sélecteur GPU : construction + montage ─────────────────────────────

    /**
     * Construit le conteneur des contrôles ComfyCH (🎮 + <select> + badge Queue
     * + bouton ⚙). Fonction PURE côté DOM : elle ne monte rien, ce qui permet
     * de la rejouer à chaque reconstruction du menu AIH (le sous-menu est
     * rebâti à chaque ouverture) sans dupliquer les identifiants.
     *
     * @returns {HTMLElement} Le conteneur prêt à être inséré.
     */
    function buildSelectorContainer() {
        // Conteneur principal
        const container = document.createElement('div');
        container.id = 'modal-gateway-container';
        container.style.cssText = [
            'display: inline-flex',
            'align-items: center',
            'margin: 0 4px',
            'gap: 4px',
            'user-select: none',
        ].join(';') + ';';

        // Icône/label
        const label = document.createElement('span');
        label.textContent = '🎮';
        label.title = 'Mode de rendu — choisissez Local ou un GPU cloud';
        label.setAttribute('aria-label', 'Mode de rendu');

        // Élément <select>
        const select = document.createElement('select');
        select.id = 'modal-gpu-selector';
        select.setAttribute('aria-label', 'Sélection du GPU');
        select.style.cssText = [
            'background: #2a2a2a',
            'color: #e0e0e0',
            'border: 1px solid #555',
            'border-radius: 4px',
            'padding: 4px 8px',
            'font-size: 13px',
            'font-family: sans-serif',
            'cursor: pointer',
            'outline: none',
        ].join(';') + ';';

        GPU_OPTIONS.forEach(function (opt) {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            select.appendChild(option);
        });

        // Valeur affichée = mode COURANT (en mémoire). Au démarrage c'est le
        // mode forcé par le serveur (« local »), sinon la préférence locale.
        // Ne JAMAIS relire localStorage ici : cela réactiverait le mode cloud
        // que le démarrage vient justement de neutraliser.
        if ([...select.options].some(function (o) { return o.value === currentRenderMode(); })) {
            select.value = currentRenderMode();
        }

        // Met à jour le mode COURANT et persiste la PRÉFÉRENCE (geste explicite
        // de l'utilisateur). Le forçage de démarrage, lui, n'écrit jamais.
        select.addEventListener('change', function () {
            runtimeMode = select.value;
            localStorage.setItem(CONFIG.STORAGE_KEY, select.value);
            // Notifier l'utilisateur du mode choisi
            const mode = select.value;
            if (mode !== 'local') {
                const gpu = mode.split(':')[1].toUpperCase();
                showNotification('☁️  Mode cloud actif — ' + gpu, 'info');
            }
        });

        // Bouton paramètres ⚙️
        const settingsBtn = document.createElement('button');
        settingsBtn.id = 'modal-settings-btn';
        settingsBtn.innerHTML = '⚙️';
        settingsBtn.title = 'Paramètres Modal Gateway';
        settingsBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;padding:4px;color:#aaa;';
        settingsBtn.addEventListener('click', function (event) {
            // Le sous-menu AIH se ferme au clic extérieur : on empêche la
            // propagation pour que la modale de réglages ne soit pas refermée
            // dans le même geste.
            event.stopPropagation();
            openSettingsModal();
        });

        container.appendChild(label);
        container.appendChild(select);

        // Queue status badge
        const queueBadge = document.createElement('span');
        queueBadge.id = 'modal-queue-badge';
        queueBadge.style.cssText = [
            'font-size: 11px', 'color: #aaa', 'padding: 2px 8px',
            'background: #1a1a2e', 'border-radius: 10px',
            'border: ' + '1px solid #333', 'display: none',
            'font-family: sans-serif', 'white-space: ' + 'nowrap',
            'cursor: pointer',
        ].join(';') + ';';
        queueBadge.textContent = 'Queue: 0';
        queueBadge.title = t(
            'comfych.run.badgeTitle',
            'Ouvrir le suivi du run (ne bloque pas ComfyUI)'
        );
        // Point d'entrée du suivi de run DANS le sous-menu ComfyCH : le badge
        // est aussi l'indicateur discret du run en cours (« File : 1 · … »).
        // Il n'efface PLUS la file au clic (action destructive inattendue) :
        // l'annulation est explicite, dans la fenêtre de suivi.
        queueBadge.addEventListener('click', function (event) {
            event.stopPropagation();
            RunMonitor.toggle();
        });
        container.appendChild(queueBadge);

        container.appendChild(settingsBtn);
        // Le menu AIH reconstruit ses contrôles à chaque ouverture : l'état du
        // badge (indicateur de run) est réappliqué APRÈS le montage, car le
        // conteneur n'est pas encore dans le document à la construction — un
        // getElementById immédiat ne trouverait pas le badge.
        setTimeout(function () {
            RenderQueue.updateUI();
        }, 0);
        return container;
    }

    /**
     * Injecte le sélecteur de GPU dans la barre d'outils HISTORIQUE de ComfyUI
     * (bouton Settings de app.menu.settingsGroup).
     *
     * ⚠️ N'est utilisé QUE si le pont du pack AI-Helper est absent : intégré au
     * pack, le sélecteur vit dans le sous-menu « AIH ▾ → Outils & Dev →
     * ComfyCH » et la barre d'outils de ComfyUI reste allégée.
     *
     * @param {object} appInstance - L'instance ComfyApp (window.app ou window.comfyAPI.app.app).
     */
    function injectDropdownInToolbar(appInstance) {
        if (dropdownInjected) return;

        var settingsButton = appInstance && appInstance.menu && appInstance.menu.settingsGroup
            ? appInstance.menu.settingsGroup.element
            : null;

        if (!settingsButton) {
            console.warn('Modal Gateway: bouton Settings non trouvé dans app.menu.settingsGroup.element', {
                hasMenu: !!(appInstance && appInstance.menu),
                menuKeys: appInstance && appInstance.menu ? Object.keys(appInstance.menu) : [],
            });
            // Réessayer plus tard (le menu peut ne pas encore être monté)
            setTimeout(function () {
                injectDropdownInToolbar(appInstance);
            }, 300);
            return;
        }

        var container = buildSelectorContainer();

        // Insérer avant le bouton Settings (comme FR.IA)
        settingsButton.parentNode.insertBefore(container, settingsButton);

        dropdownInjected = true;
        console.log('Modal Gateway: dropdown injecté dans la barre d\'outils (avant le bouton Settings)');
    }

    // ─── Pont avec le pack AI-Helper (sous-menu du menu « AIH ▾ ») ──────────
    //
    // Le pack reconstruit ses entrées de menu à chaque ouverture : il a besoin
    // d'un FOURNISSEUR de contrôles (pas d'un élément déjà monté) et d'un accès
    // à la modale de réglages. En échange, ce module ne touche JAMAIS la barre
    // d'outils de ComfyUI.
    window.AIHComfyCHHost = {
        /** Version du pont (le pack peut vérifier la compatibilité). */
        version: 1,

        /**
         * Crée des contrôles NEUFS (🎮 + sélecteur GPU + badge + ⚙).
         * @returns {HTMLElement|null} null si le module n'est pas prêt.
         */
        buildControls: function () {
            try {
                return buildSelectorContainer();
            } catch (e) {
                console.error('Modal Gateway: construction des contrôles impossible', e);
                return null;
            }
        },

        /** Ouvre la modale de réglages ComfyCH. */
        openSettings: function () {
            openSettingsModal();
        },

        /**
         * Ouvre (ou ferme) la fenêtre de suivi du run — point d'entrée
         * programmatique, en plus du badge « File : N » du sous-menu ComfyCH.
         * Non bloquant : ComfyUI reste utilisable.
         * @returns {object|null} Contrôleur AIH.Dialog, ou null si fermée.
         */
        openRunMonitor: function () {
            try {
                return RunMonitor.toggle();
            } catch (e) {
                console.error('Modal Gateway: suivi de run indisponible', e);
                return null;
            }
        },

        /** Un run est-il suivi (en cours ou dernier terminé) ? */
        hasRun: function () {
            return RunMonitor.hasRun();
        },

        /**
         * Redémarre le worker Modal (SYNC puis redémarrage, dans cet ordre).
         *
         * Demande confirmation si un rendu est en cours ; fail-closed : sans
         * confirmation, rien n'est envoyé au serveur.
         * @returns {Promise<void>}
         */
        restartWorker: function () {
            return restartWorker();
        },

        /**
         * État du suivi (lecture seule) — sert aussi de point d'observation
         * aux tests (aucune écriture exposée).
         * @returns {{status:string, running:boolean, lines:number, dropped:number, paused:boolean}}
         */
        runState: function () {
            return {
                status: RunMonitor.status,
                running: RunMonitor.isRunning(),
                runId: RunMonitor.item ? RunMonitor.item.id : null,
                lines: RunMonitor.lines.length,
                dropped: RunMonitor.dropped,
                paused: RunMonitor.paused,
                maxLines: RUN_LOG_MAX_LINES,
            };
        },

        /** Mode de rendu effectif courant (« local » ou « modal:<gpu> »). */
        currentMode: function () {
            return currentRenderMode();
        },

        /**
         * Extrait les lignes d'erreur d'un log (primitive PURE, bornée).
         *
         * Exposée pour que le pack puisse réutiliser EXACTEMENT la même
         * heuristique (et pour les tests : aucun DOM requis).
         * @param {string[]} lines - Lignes du log.
         * @param {number} [maxLines] - Plafond (défaut : interne).
         * @returns {string} Extrait court, vide si aucune erreur détectable.
         */
        extractErrorExcerpt: function (lines, maxLines) {
            return extractErrorExcerpt(lines, maxLines);
        },

        /**
         * Indicateur « il y a du contenu plus bas » d'une zone défilante.
         *
         * Primitive d'UI GÉNÉRIQUE (aucune dépendance à ComfyCH) : le pack peut
         * l'utiliser sur n'importe quel conteneur `overflow-y: auto`. Idempotent
         * — rappeler la fonction sur le même élément rend le contrôleur existant.
         * @param {HTMLElement} el - Conteneur défilant.
         * @param {{margin?: number}} [opts] - Marge de tolérance en px.
         * @returns {{el: HTMLElement, update: Function, destroy: Function}|null}
         */
        scrollHint: function (el, opts) {
            return attachScrollHint(el, opts);
        },

        /** Callback remplaçable par le pack (appelé quand la config est chargée). */
        onReady: function () {},
    };


    // ─── Interception de Queue Prompt ───────────────────────────────────────

    /**
     * Cherche l'objet API ComfyUI dans plusieurs emplacements possibles.
     * Selon la version de ComfyUI, l'API peut se trouver à différents endroits :
     * - window.api (ancienne version)
     * - window.comfyAPI.api (ComfyUI v1.30+)
     * - window.comfyAPI.app.app.api (ComfyUI v1.30+, chemin alternatif)
     * - window.comfyapp.api (autre contexte)
     * @returns {object|null} L'objet API s'il expose queuePrompt, sinon null.
     */
    function findApi() {
        var sources = [
            { obj: window.api, name: 'window.api' },
            { obj: window.comfyAPI && window.comfyAPI.api, name: 'window.comfyAPI.api' },
            { obj: window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app && window.comfyAPI.app.app.api, name: 'window.comfyAPI.app.app.api' },
            { obj: window['comfyapp'] && window['comfyapp'].api, name: 'window.comfyapp.api' },
        ];

        for (var i = 0; i < sources.length; i++) {
            var source = sources[i];
            if (source.obj && typeof source.obj.queuePrompt === 'function') {
                console.log('Modal Gateway: API trouvée via ' + source.name);
                return source.obj;
            }
        }
        return null;
    }

    // ─── Execute Cloud Render (extracted from interceptQueuePrompt) ──────────

    /**
     * Exécute un rendu cloud sur un worker Modal.
     * Extrait de l'ancienne logique inline de interceptQueuePrompt.
     * En cas d'erreur, l'appelant (RenderQueue) marque l'item comme failed
     * et la queue continue — PAS de fallback en local.
     *
     * @param {object} item - L'item de la RenderQueue à traiter.
     * @returns {Promise<object>} Le résultat JSON du worker Modal.
     */
    async function executeCloudRender(item) {
        var gpu = item.gpu;
        currentGpu = gpu;

        // Step 1: encode local images
        // Le suivi de run REMPLACE l'ancien overlay plein écran : la fenêtre
        // est non bloquante (AIH.Dialog modal:false) et reste fermable sans
        // interrompre le rendu.
        RunMonitor.begin(
            item,
            t('comfych.run.uploading', 'Transfert des fichiers vers {gpu}…', { gpu: gpu })
        );
        try {
            var enrichedWorkflow = await encodeLocalImages(item.workflow);

            // Extract API-format prompt from new ComfyUI format
            if (enrichedWorkflow && enrichedWorkflow.output && typeof enrichedWorkflow.output === 'object') {
                console.log('Modal Gateway: detected new ComfyUI format, extracting output key');
                enrichedWorkflow = enrichedWorkflow.output;
            }

            console.log('Modal Gateway: workflow keys =', Object.keys(enrichedWorkflow));
            console.log('Modal Gateway: workflow has SaveImage?', JSON.stringify(enrichedWorkflow).includes('SaveImage'));
            console.log('Modal Gateway: workflow sample =', JSON.stringify(enrichedWorkflow).substring(0, 500));

            // Step 2: send to Modal with retry (handles worker cold start 303 redirects)
            var maxRetries = 3;
            var response = null;
            for (var attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    RunMonitor.setPhase(
                        'generating',
                        t(
                            'comfych.run.generating',
                            'Génération sur {gpu} (tentative {attempt}/{max}) — le worker démarre…',
                            { gpu: gpu, attempt: attempt, max: maxRetries }
                        )
                    );

                    var controller = new AbortController();
                    var timeoutId = setTimeout(function () { controller.abort(); }, CONFIG.TIMEOUT_MS);

                    response = await fetch(CONFIG.API_URL + '/generate', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-Key': CONFIG.API_KEY,
                        },
                        body: JSON.stringify({
                            workflow: enrichedWorkflow,
                            gpu: gpu,
                            request_id: item.requestId,
                        }),
                        signal: controller.signal,
                    });

                    clearTimeout(timeoutId);
                    break; // Success, exit retry loop
                } catch (fetchErr) {
                    clearTimeout(timeoutId);
                    if (attempt < maxRetries && fetchErr.name === 'AbortError') {
                        // AbortError = timeout, not a cold start issue
                        throw fetchErr;
                    }
                    if (attempt < maxRetries) {
                        console.warn('Modal Gateway: fetch attempt ' + attempt + ' failed, retrying in 5s...', fetchErr.message);
                        RunMonitor.setPhase(
                            'retrying',
                            t(
                                'comfych.run.retrying',
                                'Worker en cours de démarrage — nouvelle tentative dans 5s ({attempt}/{max})',
                                { attempt: attempt + 1, max: maxRetries }
                            )
                        );
                        await new Promise(function(resolve) { setTimeout(resolve, 5000); });
                    } else {
                        throw fetchErr; // All retries exhausted
                    }
                }
            }

            if (!response) {
                throw new Error('All fetch attempts failed');
            }

            if (!response.ok) {
                var errorText = '';
                try {
                    var errJson = await response.json();
                    errorText = errJson.detail || errJson.error || JSON.stringify(errJson);
                } catch (_) {
                    try { errorText = await response.text(); } catch (_2) { errorText = '(erreur de lecture)'; }
                }
                throw new Error('HTTP ' + response.status + ': ' + errorText);
            }

            var result = await response.json();

            // Step 3: process response — save locally + display
            if (result.images && result.images.length > 0) {
                var imageCount = 0;
                // Toutes les images affichables sont collectées pendant la
                // boucle puis affichées en UNE seule passe : sinon l'overlay
                // se déclenche sur la 1re image et les suivantes restent en
                // attente jusqu'au rendu suivant.
                var pendingDisplay = [];
                for (var i = 0; i < result.images.length; i++) {
                    var img = result.images[i];
                    if (img.data) {
                        // Save all files locally (images ET sideloads)
                        fetch('/api/modal/save-local', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                filename: img.filename || ('modal_output_' + i + '.png'),
                                subfolder: img.subfolder || '',
                                type: img.type || 'output',
                                data: img.data,
                            }),
                        }).catch(function (e) {
                            console.warn('Modal Gateway: auto-save failed for', img.filename, e);
                        });

                        // Only display image files (skip .txt, .json sideloads)
                        if (!img.is_sideload) {
                            imageCount++;
                            pendingDisplay.push({
                                data: img.data,
                                filename: img.filename || ('output_' + i + '.png'),
                            });
                        }
                    }
                }
                if (pendingDisplay.length > 0) {
                    displayImagesInCanvas(pendingDisplay);
                }
                showNotification('✅  ' + imageCount + ' image(s) + ' + (result.images.length - imageCount) + ' fichier(s) — Render #' + item.id, 'success');
            } else {
                showNotification('✅  Génération terminée sur ' + gpu + ' (Render #' + item.id + ')', 'info');
            }

            // Le run est conclu AVANT l'affichage des images rapatriées : le
            // suivi indique « Terminé » et garde le log complet consultable.
            RunMonitor.finish('success');
            return result;
        } catch (err) {
            // L'erreur remonte à RenderQueue.process() qui conclut le suivi
            // (statut « Échec », message et log copiables) et continue la file.
            throw err;
        }
    }

    /**
     * Patche queuePrompt pour intercepter les envois de workflow.
     * Utilise findApi() pour localiser l'API ComfyUI quel que soit l'emplacement.
     * En mode "local", le comportement d'origine est conservé.
     * En mode "modal:*", le workflow est mis dans la RenderQueue et exécuté
     * via executeCloudRender().
     */
    function interceptQueuePrompt() {
        var api = findApi();

        if (!api) {
            // L'API ComfyUI n'est pas encore trouvée — on réessaie plus tard
            return false;
        }

        // Réinitialiser le compteur de tentatives si on a enfin trouvé l'API
        if (window._modalGatewayRetryCount !== undefined) {
            window._modalGatewayRetryCount = 0;
        }

        var originalQueue = api.queuePrompt.bind(api);

        api.queuePrompt = async function (number, workflow, options) {
            var select = document.getElementById('modal-gpu-selector');
            var mode = select ? select.value : 'local';

            // ── Mode local: pas de queue ──
            if (mode === 'local') {
                return originalQueue(number, workflow, options);
            }

            // ── Mode cloud: mettre dans la queue ──
            var gpu = mode.split(':')[1];
            if (!gpu) {
                showNotification('⚠️  GPU invalide, fallback en local.', 'error');
                return originalQueue(number, workflow, options);
            }

            return RenderQueue.enqueue(number, workflow, options, gpu.toUpperCase());
        };

        return true; // Interception réussie
    }

    // ─── Affichage des images reçues dans le canvas ─────────────────────────

    /**
     * Affiche les images générées (base64) dans un overlay plein écran sur la page.
     *
     * Au lieu d'utiliser window.open() avec une data URL — ce qui est bloqué par
     * les popup blockers — on crée un overlay modal dans la page courante.
     * Les images sont collectées au fur et à mesure et affichées quand la dernière
     * arrive (isLast = true).
     *
     * @param {string} base64Data - Données de l'image encodées en base64 (sans préfixe).
     * @param {string} filename - Nom du fichier (pour référence / téléchargement).
     * @param {boolean} [isLast=false] - Si true, affiche l'overlay avec toutes les images collectées.
     */
    function displayImageInCanvas(base64Data, filename, isLast) {
        // Compatibilité : collecte image par image, affiche quand isLast.
        if (!window._modalGatewayImages) {
            window._modalGatewayImages = [];
        }
        window._modalGatewayImages.push({
            data: base64Data,
            filename: filename || 'modal_output.png',
        });

        if (!isLast) return;

        var images = window._modalGatewayImages;
        window._modalGatewayImages = []; // reset for next batch
        displayImagesInCanvas(images);
    }

    /**
     * Affiche un lot complet d'images dans l'overlay, en une seule passe.
     *
     * @param {Array<{data: string, filename: string}>} images
     */
    function displayImagesInCanvas(images) {
        if (!images || images.length === 0) return;

        // Remove any existing overlay
        var existing = document.getElementById('modal-image-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'modal-image-overlay';
        overlay.style.cssText = [
            'position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
            'background: rgba(0,0,0,0.85)', 'z-index: 99999',
            'display: flex', 'flex-direction: column', 'align-items: center', 'justify-content: center',
            'padding: 20px', 'box-sizing: border-box', 'backdrop-filter: blur(4px)',
        ].join(';') + ';';

        // Header bar
        var header = document.createElement('div');
        header.style.cssText = [
            'position: absolute', 'top: 0', 'left: 0', 'right: 0',
            'display: flex', 'justify-content: space-between', 'align-items: center',
            'padding: 16px 24px', 'box-sizing: border-box',
        ].join(';') + ';';

        var title = document.createElement('div');
        title.style.cssText = 'color: #fff; font-size: 16px; font-family: sans-serif;';
        title.textContent = '🖼️ Modal Gateway — ' + images.length + ' image(s) reçue(s)';

        var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = [
            'background: rgba(255,255,255,0.15)', 'border: none', 'color: #fff',
            'font-size: 24px', 'cursor: pointer', 'padding: 4px 12px',
            'border-radius: 6px', 'line-height: 1',
        ].join(';') + ';';
        closeBtn.onmouseover = function () { closeBtn.style.background = 'rgba(255,255,255,0.3)'; };
        closeBtn.onmouseout = function () { closeBtn.style.background = 'rgba(255,255,255,0.15)'; };

        header.appendChild(title);
        header.appendChild(closeBtn);
        overlay.appendChild(header);

        // Image container (scrollable if multiple images)
        var imgContainer = document.createElement('div');
        imgContainer.style.cssText = [
            'max-width: 90%', 'max-height: 85%', 'overflow-y: auto',
            'display: flex', 'flex-direction: ' + (images.length > 1 ? 'column' : 'row'),
            'gap: 16px', 'align-items: ' + (images.length > 1 ? 'center' : 'stretch'),
            'padding-top: 60px',
        ].join(';') + ';';

        for (var i = 0; i < images.length; i++) {
            (function (imgData, imgFilename) {
                var wrapper = document.createElement('div');
                wrapper.style.cssText = 'position: relative; display: inline-block;';

                var isVideo = (imgFilename || '').toLowerCase().endsWith('.mp4');
                var mediaEl;
                if (isVideo) {
                    mediaEl = document.createElement('video');
                    mediaEl.src = 'data:video/mp4;base64,' + imgData.data;
                    mediaEl.controls = true;
                } else {
                    mediaEl = document.createElement('img');
                    mediaEl.src = 'data:image/png;base64,' + imgData.data;
                }
                mediaEl.style.cssText = [
                    'max-width: 100%', 'max-height: 80vh',
                    'border-radius: 8px', 'box-shadow: 0 8px 32px rgba(0,0,0,0.5)',
                    'object-fit: contain',
                ].join(';') + ';';

                // Download button (always visible)
                var dlBtn = document.createElement('a');
                dlBtn.href = isVideo ? 'data:video/mp4;base64,' + imgData.data : 'data:image/png;base64,' + imgData.data;
                dlBtn.download = imgFilename;
                dlBtn.innerHTML = '💾 Save';
                dlBtn.style.cssText = [
                    'position: absolute', 'top: 12px', 'right: 12px',
                    'background: rgba(74,74,255,0.9)', 'color: #fff',
                    'padding: 8px 16px', 'border-radius: 8px',
                    'font-size: 14px', 'font-family: sans-serif',
                    'text-decoration: none', 'cursor: pointer',
                    'font-weight: 600', 'box-shadow: 0 4px 12px rgba(0,0,0,0.4)',
                    'transition: background 0.2s',
                ].join(';') + ';';
                dlBtn.onmouseover = function () { dlBtn.style.background = 'rgba(90,90,255,1)'; };
                dlBtn.onmouseout = function () { dlBtn.style.background = 'rgba(74,74,255,0.9)'; };

                wrapper.appendChild(mediaEl);
                wrapper.appendChild(dlBtn);
                imgContainer.appendChild(wrapper);
            })(images[i], images[i].filename);
        }

        overlay.appendChild(imgContainer);
        document.body.appendChild(overlay);

        // Close handlers
        function closeOverlay() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            document.removeEventListener('keydown', escHandler);
        }

        function escHandler(e) {
            if (e.key === 'Escape') closeOverlay();
        }

        closeBtn.onclick = closeOverlay;
        overlay.onclick = function (e) {
            if (e.target === overlay || e.target === header) closeOverlay();
        };
        document.addEventListener('keydown', escHandler);

        console.log('Modal Gateway: ' + images.length + ' image(s) affichée(s) dans l\'overlay');
    }

    // ─── Suivi de run (fenêtre NON bloquante) ───────────────────────────────
    //
    // REMPLACE l'ancien overlay de chargement (#modal-loading-overlay) : fond
    // plein écran `position: fixed` + bulle CENTRÉE en `pointer-events: auto`,
    // qui captait les clics au milieu de ComfyUI et n'affichait qu'une ligne
    // d'info. Ici, la fenêtre est un AIH.Dialog NON modal (`modal: false`) :
    // aucun overlay n'est créé (js/aih_dialog.js, l.430-468), ComfyUI reste
    // utilisable, la fenêtre est déplaçable/redimensionnable et FERMER
    // n'annule JAMAIS le run (aucun AbortController n'est touché).

    /** Identifiant stable de la fenêtre de suivi (anti-doublon AIH.Dialog). */
    var RUN_MONITOR_ID = 'comfych-run-monitor';

    /** Plafond de lignes conservées (mémoire bornée, signalé dans l'UI). */
    var RUN_LOG_MAX_LINES = 800;

    /**
     * Plafond de lignes copiées par « Copier l'erreur ».
     *
     * RETOUR UTILISATEUR : « copy error et copy log ça fait la même chose ».
     * C'était vrai en pratique : l'extrait remontait TOUT depuis le dernier
     * « Traceback », soit le log entier quand le traceback était en haut —
     * et jusqu'à 200 lignes par le repli par motifs. « Copier l'erreur » doit
     * rester un EXTRAIT court (message + pile), le log complet restant le rôle
     * de « Copier le log ».
     */
    var RUN_ERROR_MAX_LINES = 60;

    /**
     * Motifs qui trahissent une ERREUR dans un log ComfyUI / worker Modal.
     * Inclut les lignes de pile (``Traceback``), les exceptions Python
     * (``RuntimeError``…), les erreurs de chargement ComfyUI
     * (``missing_node_type``) et les échecs mémoire/HTTP 5xx.
     */
    var RUN_ERROR_LINE_RE = /(\bERROR\b|\bCRITICAL\b|\bFATAL\b|Traceback \(most recent call last\)|\b[A-Za-z]*(?:Error|Exception)\b|missing_node_type|out of memory|CUDA error|HTTP 5\d\d)/;

    /** Lignes demandées au worker à chaque rafraîchissement (≤ 2000 côté serveur). */
    var RUN_LOG_TAIL_LINES = 400;

    /** Période de rafraîchissement du log worker (ms). */
    var RUN_LOG_POLL_MS = 2500;

    /** Seuil (px) en dessous duquel le défilement est considéré « en bas ». */
    var RUN_SCROLL_BOTTOM_PX = 24;

    /** États terminaux du suivi (le run ne reprend plus). */
    var RUN_END_STATES = { success: true, failed: true, cancelled: true };

    /** Crée un élément avec une classe et un texte (aucun innerHTML de données). */
    function runEl(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined && text !== null) el.textContent = text;
        return el;
    }

    /** Bouton d'action du suivi (icône de la façade du pack, jamais d'emoji). */
    function runButton(action, label, iconName) {
        var btn = runEl('button', 'comfych-run-btn');
        btn.type = 'button';
        btn.dataset.act = action;
        if (iconName) {
            var icon = runEl('span', 'comfych-run-icon');
            icon.innerHTML = aihIconSvg(iconName, { size: 13 });
            btn.appendChild(icon);
        }
        btn.appendChild(document.createTextNode(label));
        return btn;
    }

    /** Durée lisible ("12s", "2min 05s"). */    function runDuration(startedAt, endedAt) {
        if (!startedAt) return '';
        var until = endedAt || Date.now();
        var seconds = Math.max(0, Math.round((until - startedAt) / 1000));
        if (seconds < 60) return seconds + 's';
        var minutes = Math.floor(seconds / 60);
        var rest = seconds % 60;
        return minutes + 'min ' + (rest < 10 ? '0' : '') + rest + 's';
    }

    /**
     * Une ligne du log ressemble-t-elle à une ERREUR ? (détection seule)
     *
     * @param {string} line
     * @returns {boolean}
     */
    function isErrorLine(line) {
        return RUN_ERROR_LINE_RE.test(String(line === undefined || line === null ? '' : line));
    }

    /**
     * Ligne est-elle une CONTINUATION de pile / d'exception ?
     *
     * Couvre les lignes indentées (``  File "…", line 12``), les lignes
     * ``Caused by``/``During handling of…`` et les chaînages ``^^^``.
     */
    function isStackContinuation(line) {
        var value = String(line === undefined || line === null ? '' : line);
        if (!value.trim()) return false;
        if (/^\s+/.test(value)) return true;                       // indentation
        if (/^(Caused by|During handling)/i.test(value)) return true;
        return /^\s*[\^~]+\s*$/.test(value);                      // soulignement Python
    }

    /**
     * Extrait COURTE des lignes d'erreur d'un log (fonction PURE, testable).
     *
     * Stratégie (heuristique demandée, bornée dans TOUS les cas) :
     *   1. s'il existe au moins un ``Traceback (most recent call last)``, on
     *      renvoie le DERNIER bloc (traceback + suite), plafonné ;
     *   2. sinon on garde les lignes qui matchent ``RUN_ERROR_LINE_RE`` ET
     *      leurs lignes de continuation (pile indentée), les PLUS RÉCENTES
     *      d'abord si le plafond est dépassé.
     *
     * Un log de 2000 lignes ne produit donc jamais 2000 lignes copiées :
     * « Copier l'erreur » reste un extrait, « Copier le log » copie tout.
     *
     * @param {string[]} lines - Lignes du log.
     * @param {number} [maxLines] - Plafond (défaut RUN_ERROR_MAX_LINES).
     * @returns {string} Extrait (vide si aucune erreur détectable).
     */
    function extractErrorExcerpt(lines, maxLines) {
        var limit = maxLines > 0 ? maxLines : RUN_ERROR_MAX_LINES;
        if (!Array.isArray(lines) || lines.length === 0) return '';

        var start = -1;
        for (var i = lines.length - 1; i >= 0; i--) {
            if (/^\s*Traceback \(most recent call last\)/.test(lines[i])) { start = i; break; }
        }
        if (start >= 0) {
            var block = lines.slice(start);
            // ``slice`` peut être énorme si le traceback est EN HAUT : on garde
            // la FIN du bloc (l'exception finale est la plus informative).
            if (block.length > limit) block = block.slice(-limit);
            return block.join('\n').trim();
        }

        var picked = [];
        for (var j = 0; j < lines.length; j++) {
            if (!isErrorLine(lines[j])) continue;
            picked.push(lines[j]);
            for (var k = j + 1; k < lines.length; k++) {
                if (!isStackContinuation(lines[k])) break;
                picked.push(lines[k]);
                j = k;
            }
        }
        if (picked.length > limit) picked = picked.slice(-limit);
        return picked.join('\n').trim();
    }

    /** Y a-t-il une erreur détectable (message du run ou log) ? */
    function logHasError(lines) {
        if (!Array.isArray(lines)) return false;
        for (var i = 0; i < lines.length; i++) {
            if (isErrorLine(lines[i])) return true;
        }
        return false;
    }

    /** Libellé traduit d'un état de run. */
    function runStatusLabel(status) {
        switch (status) {
            case 'uploading': return t('comfych.run.stateUploading', 'Transfert des fichiers');
            case 'generating': return t('comfych.run.stateGenerating', 'Génération');
            case 'retrying': return t('comfych.run.stateRetrying', 'Nouvelle tentative');
            case 'success': return t('comfych.run.stateSuccess', 'Terminé');
            case 'failed': return t('comfych.run.stateFailed', 'Échec');
            case 'cancelled': return t('comfych.run.stateCancelled', 'Annulé');
            default: return t('comfych.run.stateIdle', 'Aucun run');
        }
    }

    /**
     * Copie *text* dans le presse-papiers.
     *
     * ``navigator.clipboard`` d'abord (contexte sécurisé), puis repli par
     * ``<textarea>`` + ``document.execCommand('copy')`` quand l'API est absente
     * ou refusée (iframe, permissions).
     *
     * @param {string} text
     * @returns {Promise<boolean>} true si la copie a réussi.
     */
    function copyToClipboard(text) {
        var value = String(text === undefined || text === null ? '' : text);
        var clip = navigator && navigator.clipboard;
        if (clip && typeof clip.writeText === 'function') {
            return Promise.resolve(clip.writeText(value)).then(
                function () { return true; },
                function () { return fallbackCopy(value); }
            );
        }
        return Promise.resolve(fallbackCopy(value));
    }

    /** Repli de copie (aucune API moderne disponible). */
    function fallbackCopy(value) {
        try {
            var area = document.createElement('textarea');
            area.value = value;
            area.setAttribute('readonly', 'readonly');
            area.style.position = 'fixed';
            area.style.top = '-1000px';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            var ok = typeof document.execCommand === 'function' && document.execCommand('copy');
            area.remove();
            return !!ok;
        } catch (e) {
            return false;
        }
    }

    /**
     * Fenêtre de suivi du run Modal (infos + logs en direct + erreur copiable).
     *
     * Contrat :
     *  - NON BLOQUANTE : aucune couche plein écran, aucun piège de focus — la
     *    fenêtre se déplace, se redimensionne (position mémorisée) et se ferme
     *    sans interrompre le rendu ;
     *  - ROUVRABLE : l'état (lignes, statut, erreur) vit ICI, pas dans le DOM ;
     *  - LOGS EN DIRECT : polling de la route existante
     *    ``GET /api/modal/worker-logs`` (tail du log ComfyUI du worker Modal),
     *    différé par ancre pour n'ajouter que les lignes nouvelles ;
     *  - PLAFOND : ``RUN_LOG_MAX_LINES`` lignes conservées, le reste est
     *    signalé (jamais 100 000 lignes en mémoire).
     */
    var RunMonitor = {
        item: null,        // run suivi (item de RenderQueue), null = aucun
        status: 'idle',    // uploading | generating | retrying | success | failed | cancelled
        phase: '',         // message de phase (texte lisible)
        error: '',         // message d'erreur du run
        lines: [],         // lignes affichées (≤ RUN_LOG_MAX_LINES)
        dropped: 0,        // lignes retirées par le plafond
        tail: [],          // dernière queue reçue du worker (base du diff)
        logWarning: '',    // log worker indisponible (raison lisible)
        startedAt: 0,
        endedAt: 0,
        paused: false,     // défilement auto suspendu (l'utilisateur remonte)
        ctrl: null,        // contrôleur AIH.Dialog
        els: null,         // éléments DOM montés
        _pollTimer: null,
        _tickTimer: null,
        _polling: false,

        /** Un run est-il suivi (en cours OU dernier terminé) ? */
        hasRun: function () {
            return !!this.item;
        },

        /** La fenêtre est-elle ouverte ? */
        isOpen: function () {
            return !!this.ctrl;
        },

        /** Le run suivi est-il encore en cours ? */
        isRunning: function () {
            return !!this.item && !RUN_END_STATES[this.status];
        },

        /** Démarre le suivi d'un run et ouvre la fenêtre. */
        begin: function (item, message) {
            this.item = item || null;
            this.status = 'uploading';
            this.phase = message || '';
            this.error = '';
            this.lines = [];
            this.dropped = 0;
            this.tail = [];
            this.logWarning = '';
            this.startedAt = Date.now();
            this.endedAt = 0;
            this.paused = false;
            this.open();
            this.renderInfo();
            this.startPolling();
            RenderQueue.updateUI();
        },

        /** Change la phase du run (transfert, génération, nouvelle tentative). */
        setPhase: function (status, message) {
            if (!this.item || RUN_END_STATES[this.status]) return;
            this.status = status || this.status;
            this.phase = message || this.phase;
            this.renderInfo();
        },

        /**
         * Conclut le run suivi.
         * @param {'success'|'failed'|'cancelled'} outcome
         * @param {string} [errorMessage]
         */
        finish: function (outcome, errorMessage) {
            if (!this.item) return;
            this.status = outcome || 'failed';
            this.error = errorMessage ? String(errorMessage) : '';
            this.endedAt = Date.now();
            this.phase = '';
            this.stopTick();
            this.stopPolling();
            this.renderInfo();
            this.renderError();
            this.renderLog();
            // Deux dernières lectures : le worker peut finir d'écrire son log
            // APRÈS la réponse HTTP (flush du volume).
            var self = this;
            this.poll();
            setTimeout(function () { self.poll(); }, 2000);
            if (this.status === 'success') this.scrollToEnd(true);
            RenderQueue.updateUI();
        },

        /** Ouvre (ou ramène au premier plan) la fenêtre de suivi. */
        open: function () {
            if (this.ctrl) {
                if (typeof this.ctrl.bringToFront === 'function') this.ctrl.bringToFront();
                this.renderInfo();
                return this.ctrl;
            }
            var Dialog = window.AIH && window.AIH.Dialog;
            if (!Dialog || typeof Dialog.open !== 'function') {
                // Dégradé : le pack n'est pas chargé (le chargeur importe
                // pourtant aih_dialog.js avant ce module → cas exceptionnel).
                console.warn('Modal Gateway: AIH.Dialog indisponible — suivi en notification seulement.');
                showNotification(this.phase || runStatusLabel(this.status), 'info');
                return null;
            }
            var self = this;
            this.ctrl = Dialog.open({
                id: RUN_MONITOR_ID,
                title: t('comfych.run.title', 'Run Modal') + (this.item ? ' #' + this.item.id : ''),
                width: '640px',
                height: '480px',
                minWidth: '340px',
                minHeight: '240px',
                maxWidth: '96vw',
                maxHeight: '92vh',
                // ↓ AUCUN overlay : « modal: false » (aih_dialog.js l.430-468).
                modal: false,
                resizable: true,
                draggable: true,
                // Échap ferme la fenêtre — et n'annule PAS le run.
                closeOnEscape: true,
                focusTrap: false,
                content: function (body) {
                    self.els = self.build(body);
                },
                onClose: function () {
                    // Fermer ≠ annuler : on oublie seulement le DOM.
                    self.ctrl = null;
                    self.els = null;
                },
            });
            this.renderInfo();
            this.renderLog();
            this.renderError();
            return this.ctrl;
        },

        /** Ferme la fenêtre (le run continue). */
        close: function () {
            if (this.ctrl && typeof this.ctrl.close === 'function') this.ctrl.close();
            this.ctrl = null;
            this.els = null;
        },

        /** Bascule ouvert/fermé (point d'entrée du menu ComfyCH). */
        toggle: function () {
            if (this.ctrl) {
                this.close();
                return null;
            }
            return this.open();
        },

        /** Construit le contenu de la fenêtre (appelé une fois par ouverture). */
        build: function (body) {
            var self = this;
            var root = runEl('div', 'comfych-run');

            var info = runEl('div', 'comfych-run-info');
            var cells = {};
            [
                ['id', t('comfych.run.fieldRun', 'Run')],
                ['state', t('comfych.run.fieldState', 'État')],
                ['gpu', t('comfych.run.fieldGpu', 'GPU')],
                ['duration', t('comfych.run.fieldDuration', 'Durée')],
                ['queue', t('comfych.run.fieldQueue', 'File')],
                ['activity', t('comfych.run.fieldActivity', 'Activité du log')],
            ].forEach(function (def) {
                var cell = runEl('div', 'comfych-run-cell comfych-run-cell--' + def[0]);
                cell.appendChild(runEl('span', 'k', def[1]));
                var value = runEl('span', 'v', '—');
                cell.appendChild(value);
                cells[def[0]] = { cell: cell, value: value };
                info.appendChild(cell);
            });
            root.appendChild(info);

            var toolbar = runEl('div', 'comfych-run-toolbar');
            var notice = runEl('span', 'comfych-run-notice');
            notice.style.display = 'none';
            toolbar.appendChild(notice);

            var toEnd = runButton('to-end', t('comfych.run.goToEnd', 'Aller à la fin'), 'arrow-down');
            toEnd.style.display = 'none';
            toolbar.appendChild(toEnd);
            toolbar.appendChild(runButton('copy-all', t('comfych.run.copyAll', 'Copier le log'), 'copy'));
            var copyError = runButton('copy-error', t('comfych.run.copyError', "Copier l'erreur"), 'alert-triangle');
            toolbar.appendChild(copyError);
            var downloadBtn = runButton('download', t('comfych.run.download', 'Télécharger .txt'), 'download');
            downloadBtn.style.display = 'none';
            toolbar.appendChild(downloadBtn);
            var cancelBtn = runButton('cancel-pending', t('comfych.run.cancelQueue', 'Annuler la file'), 'ban');
            cancelBtn.style.display = 'none';
            toolbar.appendChild(cancelBtn);
            root.appendChild(toolbar);

            var errorBox = runEl('div', 'comfych-run-error');
            errorBox.style.display = 'none';
            errorBox.setAttribute('role', 'alert');
            root.appendChild(errorBox);

            var log = runEl('pre', 'comfych-run-log');
            log.tabIndex = 0;
            log.setAttribute('role', 'log');
            log.setAttribute('aria-live', 'polite');
            log.setAttribute('aria-label', t('comfych.run.logAria', 'Logs du worker Modal'));
            root.appendChild(log);

            // Pause du défilement : dès que l'utilisateur remonte, on ne lui
            // arrache plus la lecture (« Aller à la fin » réarme).
            log.addEventListener('scroll', function () { self.onLogScroll(); });

            toolbar.addEventListener('click', function (event) {
                var node = event.target;
                var btn = node && typeof node.closest === 'function'
                    ? node.closest('button[data-act]')
                    : null;
                if (!btn) return;
                self.onAction(btn.dataset.act);
            });

            body.appendChild(root);
            return {
                root: root,
                info: cells,
                toolbar: toolbar,
                notice: notice,
                toEnd: toEnd,
                copyError: copyError,
                download: downloadBtn,
                cancel: cancelBtn,
                errorBox: errorBox,
                log: log,
            };
        },

        /** Traite un clic d'action de la barre d'outils. */
        onAction: function (action) {
            var self = this;
            if (action === 'to-end') {
                this.paused = false;
                this.scrollToEnd(true);
                this.renderToEndButton();
                return;
            }
            if (action === 'copy-all') {
                copyToClipboard(this.fullLogText()).then(function (ok) {
                    showNotification(
                        ok ? t('comfych.run.copied', 'Log copié dans le presse-papiers')
                           : t('comfych.run.copyFailed', 'Copie impossible (presse-papiers refusé)'),
                        ok ? 'success' : 'error'
                    );
                });
                return;
            }
            if (action === 'copy-error') {
                // Bouton désactivé = aucune erreur : ne JAMAIS copier le log
                // entier à la place (les deux boutons feraient la même chose).
                if (!this.hasError()) {
                    showNotification(t('comfych.run.copyErrorNone', 'Aucune erreur à copier'), 'info');
                    return;
                }
                copyToClipboard(this.errorText()).then(function (ok) {
                    showNotification(
                        ok ? t('comfych.run.copiedError', "Message d'erreur copié")
                           : t('comfych.run.copyFailed', 'Copie impossible (presse-papiers refusé)'),
                        ok ? 'success' : 'error'
                    );
                });
                return;
            }
            if (action === 'download') {
                this.download();
                return;
            }
            if (action === 'cancel-pending') {
                RenderQueue.clearPending();
                self.renderInfo();
            }
        },

        /** Met à jour les infos (id, état, GPU, durée, file, activité). */
        renderInfo: function () {
            var els = this.els;
            if (!els) return;
            var item = this.item;
            var running = this.isRunning();

            els.info.id.value.textContent = item ? ('#' + item.id) : '—';
            els.info.state.value.textContent = runStatusLabel(this.status);
            els.info.state.cell.className = 'comfych-run-cell comfych-run-cell--state'
                + (RUN_END_STATES[this.status] ? ' is-' + this.status : '');
            els.info.gpu.value.textContent = item && item.gpu
                ? String(item.gpu).toUpperCase()
                : '—';
            els.info.duration.value.textContent = runDuration(this.startedAt, this.endedAt) || '—';

            var counts = RenderQueue.counts();
            els.info.queue.value.textContent = counts.pending > 0
                ? String(counts.pending)
                : t('comfych.run.queueIdle', 'Vide');

            var activity = this.phase;
            if (running && !activity) activity = runStatusLabel(this.status);
            if (!running) activity = '';
            els.info.activity.value.textContent = activity || '—';

            els.download.style.display = RUN_END_STATES[this.status] ? '' : 'none';
            els.cancel.style.display = counts.pending > 0 ? '' : 'none';

            if (this.ctrl && typeof this.ctrl.setTitle === 'function') {
                this.ctrl.setTitle(
                    t('comfych.run.title', 'Run Modal') + (item ? ' #' + item.id : '')
                );
            }
        },

        /** Réécrit la zone de log (plafonnée) et suit le bas si autorisé. */
        renderLog: function () {
            var els = this.els;
            if (!els) return;
            var text = '';
            if (this.dropped > 0) {
                text += '── ' + t(
                    'comfych.run.capped',
                    '… {count} ligne(s) plus anciennes masquées (plafond {max})',
                    { count: this.dropped, max: RUN_LOG_MAX_LINES }
                ) + ' ──\n';
            }
            if (this.logWarning) text += '!! ' + this.logWarning + '\n';
            if (this.lines.length) text += this.lines.join('\n');
            if (!text) text = t('comfych.run.emptyLog', 'En attente des logs du worker Modal…');
            els.log.textContent = text;

            els.notice.textContent = this.dropped > 0
                ? t(
                    'comfych.run.cappedShort',
                    '{count} ligne(s) masquée(s)',
                    { count: this.dropped }
                )
                : '';
            els.notice.style.display = this.dropped > 0 ? 'inline' : 'none';

            // L'état du bouton dépend aussi du LOG (une erreur peut apparaître
            // en cours de route, avant même la conclusion du run).
            this.renderCopyErrorState();

            if (!this.paused) this.scrollToEnd(false);
        },

        /**
         * Active/désactive « Copier l'erreur » selon qu'une erreur existe.
         *
         * Désactivé : l'infobulle explique POURQUOI (aucune erreur détectée)
         * et le clic ne copie rien — il ne recopie surtout pas le log complet.
         */
        renderCopyErrorState: function () {
            var els = this.els;
            if (!els || !els.copyError) return;
            var enabled = this.hasError();
            els.copyError.disabled = !enabled;
            els.copyError.classList.toggle('is-disabled', !enabled);
            els.copyError.setAttribute('aria-disabled', enabled ? 'false' : 'true');
            els.copyError.title = enabled
                ? t('comfych.run.copyErrorHint', "Copie le message d'erreur et l'extrait de pile (jamais le log complet)")
                : t('comfych.run.copyErrorNone', 'Aucune erreur à copier');
        },

        /** Affiche (ou non) le bloc d'erreur / d'annulation. */
        renderError: function () {
            var els = this.els;
            if (!els) return;
            var text = '';
            if (this.status === 'failed') text = this.errorText();
            else if (this.status === 'cancelled') text = this.error || t('comfych.run.cancelledHint', 'Run annulé.');
            if (!text) {
                els.errorBox.style.display = 'none';
                els.errorBox.textContent = '';
                this.renderCopyErrorState();
                return;
            }
            els.errorBox.style.display = 'block';
            els.errorBox.textContent = text;
            this.renderCopyErrorState();
        },

        /**
         * Une erreur est-elle copiable ? (message du run ou log)
         *
         * Sans erreur détectable, le bouton « Copier l'erreur » est DÉSACTIVÉ :
         * il ne doit jamais recopier le log entier à la place d'une erreur
         * (c'était l'impression donnée par les deux boutons identiques).
         */
        hasError: function () {
            if (this.error) return true;
            if (this.status === 'failed' || this.status === 'cancelled') return true;
            return logHasError(this.lines);
        },

        /** Texte copié par « Copier l'erreur » : message + extrait BORNÉ. */
        errorText: function () {
            var parts = [];
            if (this.error) parts.push(this.error);
            var excerpt = this.logExcerpt();
            // Le message du run peut déjà contenir le log : pas de doublon.
            if (excerpt && parts.indexOf(excerpt) === -1) parts.push(excerpt);
            if (!parts.length) return t('comfych.run.noError', 'Aucune erreur détectée dans les logs.');
            return parts.join('\n\n');
        },

        /**
         * Extrait du log utile au débogage : DERNIER traceback ou lignes
         * d'erreur (+ continuations), toujours plafonné à RUN_ERROR_MAX_LINES.
         * Fonction PURE réutilisable (voir extractErrorExcerpt).
         */
        logExcerpt: function () {
            return extractErrorExcerpt(this.lines, RUN_ERROR_MAX_LINES);
        },

        /** Contenu complet copié/téléchargé (en-tête + log + erreur). */
        fullLogText: function () {
            var item = this.item || {};
            var head = t(
                'comfych.run.fileHeader',
                'Run Modal #{id} · {state} · GPU {gpu} · durée {duration}',
                {
                    id: item.id === undefined ? '?' : item.id,
                    state: runStatusLabel(this.status),
                    gpu: item.gpu ? String(item.gpu).toUpperCase() : '?',
                    duration: runDuration(this.startedAt, this.endedAt) || '?',
                }
            );
            var header = [head];
            if (this.dropped > 0) {
                header.push(t(
                    'comfych.run.capped',
                    '… {count} ligne(s) plus anciennes masquées (plafond {max})',
                    { count: this.dropped, max: RUN_LOG_MAX_LINES }
                ));
            }
            if (this.error) {
                header.push(t('comfych.run.errorLine', 'Erreur : {message}', { message: this.error }));
            }
            return header.join('\n') + '\n\n' + this.lines.join('\n');
        },

        /** Télécharge le log complet en .txt (coût nul : Blob local). */
        download: function () {
            var text = this.fullLogText();
            var id = this.item && this.item.id !== undefined ? this.item.id : Date.now();
            var name = 'comfych-run-' + id + '.txt';
            try {
                var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                var url = URL.createObjectURL(blob);
                var link = document.createElement('a');
                link.href = url;
                link.download = name;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function () {
                    try { URL.revokeObjectURL(url); } catch (e) { /* silencieux */ }
                }, 0);
            } catch (e) {
                showNotification(
                    t('comfych.run.downloadFailed', 'Téléchargement impossible : {message}', {
                        message: (e && e.message) ? e.message : String(e),
                    }),
                    'error'
                );
            }
        },

        /** Ajoute des lignes au log (plafond appliqué, trou signalé). */
        appendLines: function (lines) {
            if (!lines || !lines.length) return;
            for (var i = 0; i < lines.length; i++) this.lines.push(String(lines[i]));
            if (this.lines.length > RUN_LOG_MAX_LINES) {
                var excess = this.lines.length - RUN_LOG_MAX_LINES;
                this.lines.splice(0, excess);
                this.dropped += excess;
            }
            this.renderLog();
        },

        /**
         * Enregistre une NOUVELLE queue de log worker et n'ajoute que le delta.
         *
         * La route renvoie les N dernières lignes (fin = EOF) : on repère la
         * dernière ligne déjà connue dans la nouvelle queue et on n'ajoute que
         * ce qui suit. Ancre introuvable = log réinitialisé (rotation) → on le
         * signale et on repart de la nouvelle queue.
         */
        setWorkerTail: function (newLines) {
            if (!newLines || !newLines.length) return;
            var old = this.tail;
            var appended;
            if (!old.length) {
                appended = newLines.slice();
            } else {
                var anchor = old[old.length - 1];
                var index = -1;
                for (var i = newLines.length - 1; i >= 0; i--) {
                    if (newLines[i] === anchor) {
                        index = i;
                        break;
                    }
                }
                if (index >= 0) {
                    appended = newLines.slice(index + 1);
                } else {
                    appended = [t('comfych.run.logReset', '── log du worker réinitialisé ──')]
                        .concat(newLines);
                }
            }
            this.tail = newLines.slice();
            if (appended.length) this.appendLines(appended);
        },

        /** Démarre le rafraîchissement périodique du log worker. */
        startPolling: function () {
            var self = this;
            this.stopPolling();
            this.poll();
            this._pollTimer = setInterval(function () { self.poll(); }, RUN_LOG_POLL_MS);
            this.startTick();
        },

        /** Arrête le rafraîchissement du log worker. */
        stopPolling: function () {
            if (this._pollTimer) {
                clearInterval(this._pollTimer);
                this._pollTimer = null;
            }
        },

        /** Tick 1 s : met à jour la durée affichée. */
        startTick: function () {
            var self = this;
            if (this._tickTimer) return;
            this._tickTimer = setInterval(function () {
                if (!self.isRunning()) self.stopTick();
                self.renderInfo();
            }, 1000);
        },

        /** Arrête le tick de durée. */
        stopTick: function () {
            if (this._tickTimer) {
                clearInterval(this._tickTimer);
                this._tickTimer = null;
            }
        },

        /** Lit la queue du log ComfyUI du worker Modal (route existante). */
        poll: function () {
            var self = this;
            if (this._polling || !this.item) return;
            this._polling = true;
            var url = '/api/modal/worker-logs?lines=' + RUN_LOG_TAIL_LINES;
            if (this.item.gpu) url += '&gpu=' + encodeURIComponent(this.item.gpu);
            Promise.resolve(fetch(url))
                .then(function (resp) { return resp.json(); })
                .then(function (data) {
                    if (data && Array.isArray(data.lines)) {
                        self.logWarning = '';
                        self.setWorkerTail(data.lines);
                    } else if (data && data.error) {
                        self.logWarning = t(
                            'comfych.run.logUnavailable',
                            'Logs worker indisponibles : {message}',
                            { message: String(data.error) }
                        );
                        self.renderLog();
                    }
                    self.renderInfo();
                })
                .catch(function (e) {
                    self.logWarning = t(
                        'comfych.run.logUnavailable',
                        'Logs worker indisponibles : {message}',
                        { message: (e && e.message) ? e.message : String(e) }
                    );
                    self.renderLog();
                })
                .then(function () { self._polling = false; });
        },

        /** Défile en bas (sans casser la pause si *force* est faux). */
        scrollToEnd: function (force) {
            var els = this.els;
            if (!els || !els.log) return;
            if (force) this.paused = false;
            if (this.paused) return;
            try {
                els.log.scrollTop = els.log.scrollHeight;
            } catch (e) { /* jsdom / navigateur sans layout : sans effet */ }
        },

        /** Détecte le défilement manuel : en bas = auto, sinon pause. */
        onLogScroll: function () {
            var els = this.els;
            if (!els || !els.log) return;
            var log = els.log;
            var atBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) <= RUN_SCROLL_BOTTOM_PX;
            this.paused = !atBottom;
            this.renderToEndButton();
        },

        /** Affiche le bouton « Aller à la fin » uniquement en pause. */
        renderToEndButton: function () {
            var els = this.els;
            if (!els || !els.toEnd) return;
            els.toEnd.style.display = this.paused ? '' : 'none';
        },
    };

    // ─── Notifications utilisateur ──────────────────────────────────────────

    /**
     * Affiche une notification temporaire en bas à droite.
     * @param {string} msg - Message à afficher.
     * @param {'error'|'success'|'info'} type - Type de notification (couleur).
     */
    function showNotification(msg, type) {
        type = type || 'info';

        var el = document.createElement('div');
        el.className = 'modal-notification modal-notification--' + type;
        el.textContent = msg;

        document.body.appendChild(el);

        // Disparition automatique après 5 secondes
        setTimeout(function () {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.5s ease';
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 500);
        }, 5000);
    }

    // ─── Styles CSS de la modale ────────────────────────────────────────────

    /**
     * Injecte les styles CSS pour la modale de configuration dans le <head>.
     * Appelée une fois au démarrage.
     */
    function injectModalStyles() {
        if (document.getElementById('modal-settings-styles')) return;

        var style = document.createElement('style');
        style.id = 'modal-settings-styles';
        style.textContent = [
            // ─── Drodown du sélecteur GPU ───
            '#modal-gateway-container {',
            '  display: inline-flex;',
            '  align-items: center;',
            '  margin: 0 8px;',
            '  gap: 4px;',
            '  user-select: none;',
            '}',
            '#modal-gpu-selector {',
            '  background: #2a2a2a;',
            '  color: #e0e0e0;',
            '  border: 1px solid #555;',
            '  border-radius: 4px;',
            '  padding: 4px 8px;',
            '  font-size: 13px;',
            '  font-family: sans-serif;',
            '  cursor: pointer;',
            '  outline: none;',
            '  transition: border-color 0.2s ease, box-shadow 0.2s ease;',
            '}',
            '#modal-gpu-selector:hover { border-color: #888; }',
            '#modal-gpu-selector:focus {',
            '  border-color: #4caf50;',
            '  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.25);',
            '}',
            '#modal-gpu-selector option {',
            '  background: #1e1e1e;',
            '  color: #e0e0e0;',
            '  padding: 4px 8px;',
            '}',
            '',
            // ─── Suivi de run (fenêtre AIH.Dialog NON bloquante) ───
            // Plus d'overlay plein écran : la fenêtre est un AIH.Dialog
            // modal:false (déplaçable/redimensionnable, sans fond capturant).
            '.comfych-run {',
            '  display: flex; flex-direction: column; gap: 8px;',
            '  height: 100%; min-height: 0;',
            '  font-family: sans-serif; font-size: 12px;',
            '  color: var(--aih-text, #e0e0e0);',
            '}',
            '.comfych-run-info {',
            '  flex: 0 0 auto; display: grid;',
            '  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));',
            '  gap: 6px 8px;',
            '}',
            '.comfych-run-cell {',
            '  display: flex; flex-direction: column; gap: 2px; min-width: 0;',
            '  padding: 4px 8px; border-radius: 6px;',
            '  background: rgba(255, 255, 255, 0.04);',
            '  border: 1px solid var(--aih-border, #3f3f3f);',
            '}',
            '.comfych-run-cell .k {',
            '  font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase;',
            '  color: var(--aih-text-secondary, #a0a0a0);',
            '}',
            '.comfych-run-cell .v {',
            '  font-size: 12px; white-space: nowrap;',
            '  overflow: hidden; text-overflow: ellipsis;',
            '}',
            '.comfych-run-cell--state .v { font-weight: 600; }',
            '.comfych-run-cell.is-success .v { color: #4ade80; }',
            '.comfych-run-cell.is-failed .v { color: #f87171; }',
            '.comfych-run-cell.is-cancelled .v { color: #fbbf24; }',
            '.comfych-run-toolbar {',
            '  flex: 0 0 auto; display: flex; flex-wrap: wrap;',
            '  align-items: center; gap: 6px;',
            '}',
            '.comfych-run-notice { font-size: 11px; color: #fbbf24; }',
            '.comfych-run-btn {',
            '  display: inline-flex; align-items: center; gap: 4px;',
            '  padding: 3px 9px; border-radius: 6px; cursor: pointer;',
            '  font-size: 11px; color: inherit;',
            '  background: var(--aih-btn-bg, #3a3a3e);',
            '  border: 1px solid var(--aih-btn-border, #555);',
            '}',
            '.comfych-run-btn:hover { background: var(--aih-btn-bg-hover, #4a4a4e); }',
            // Bouton SANS erreur à copier : visiblement inactif (jamais muet).
            '.comfych-run-btn:disabled, .comfych-run-btn.is-disabled {',
            '  opacity: 0.45; cursor: not-allowed;',
            '  background: transparent;',
            '}',
            '.comfych-run-btn:disabled:hover { background: transparent; }',
            '.comfych-run-icon { display: inline-flex; align-items: center; }',
            '.comfych-run-error {',
            '  flex: 0 0 auto; max-height: 110px; overflow: auto;',
            '  padding: 6px 8px; border-radius: 4px;',
            '  border-left: 3px solid #f87171;',
            '  background: rgba(248, 113, 113, 0.10);',
            '  white-space: pre-wrap; word-break: break-word;',
            '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;',
            '  font-size: 11px;',
            '}',
            '.comfych-run-log {',
            '  flex: 1 1 auto; min-height: 80px; margin: 0; overflow: auto;',
            '  padding: 6px 8px; border-radius: 6px;',
            '  background: #111114;',
            '  border: 1px solid var(--aih-border, #3f3f3f);',
            '  white-space: pre-wrap; word-break: break-word;',
            '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;',
            '  font-size: 11px; line-height: 1.45;',
            '}',
            '.comfych-run-log:focus { outline: 1px solid var(--aih-accent, #d8700d); }',
            '@keyframes modal-spin { to { transform: rotate(360deg); } }',
            '',
            // ─── Notification ───
            '.modal-notification {',
            '  position: fixed;',
            '  bottom: 20px;',
            '  right: 20px;',
            '  padding: 12px 20px;',
            '  border-radius: 8px;',
            '  font-size: 14px;',
            '  z-index: 99998;',
            '  font-family: sans-serif;',
            '  animation: modal-fadeIn 0.3s ease-out;',
            '  color: #fff;',
            '  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);',
            '  max-width: 360px;',
            '  line-height: 1.4;',
            '}',
            '.modal-notification--error {',
            '  background: #c0392b;',
            '  border-left: 4px solid #e74c3c;',
            '}',
            '.modal-notification--success {',
            '  background: #27ae60;',
            '  border-left: 4px solid #2ecc71;',
            '}',
            '.modal-notification--info {',
            '  background: #2980b9;',
            '  border-left: 4px solid #3498db;',
            '}',
            '@keyframes modal-fadeIn {',
            '  from { opacity: 0; transform: translateY(12px); }',
            '  to { opacity: 1; transform: translateY(0); }',
            '}',
            '',
            // ─── Overlay de la modale de configuration ───
            '#modal-settings-overlay {',
            '  position: fixed; top: 0; left: 0; width: 100%; height: 100%;',
            '  background: rgba(0,0,0,0.6); z-index: 9999;',
            '  display: flex; align-items: center; justify-content: center;',
            '  animation: modal-fade-in 0.2s ease;',
            '}',
            '@keyframes modal-fade-in {',
            '  from { opacity: 0; }',
            '  to { opacity: 1; }',
            '}',
            '/* Panneau de la modale */',
            '/* Colonne flex : le scroll est interne (étapes à hauteur fixe + logs extensibles). */',
            '/* La hauteur est pilotable au clavier/souris via la poignée de resize (bas du panneau) */',
            '/* et persistée dans localStorage (clé modal-panel-height). */',
            '.modal-settings-panel {',
            '  background: #2a2a2e; color: #e0e0e0;',
            '  border-radius: 12px;',
            '  width: min(1240px, 96vw);',
            '  height: var(--modal-panel-height, min(780px, 94vh));',
            '  display: flex; flex-direction: column;',
            '  /* Les cadres d\'étapes gardent leur hauteur fixe : si le panneau est trop',
            '     court (Connexion dépliée, panneau réduit à 480 px), c\'est le panneau qui',
            '     défile au lieu de comprimer les cadres. */',
            '  overflow-y: auto; overflow-x: hidden;',
            '  box-shadow: 0 8px 32px rgba(0,0,0,0.5);',
            '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
            '  font-size: 14px; line-height: 1.5;',
            '  animation: modal-slide-in 0.25s ease;',
            '}',
            '@keyframes modal-slide-in {',
            '  from { transform: translateY(-20px); opacity: 0; }',
            '  to { transform: translateY(0); opacity: 1; }',
            '}',
            '/* En-tête */',
            '.modal-settings-header {',
            '  flex-shrink: 0;',
            '  display: flex; align-items: center; gap: 14px;',
            '  padding: 12px 18px; border-bottom: 1px solid #3a3a3e;',
            '}',
            '.modal-settings-header h2 {',
            '  margin: 0; font-size: 15px; font-weight: 600; white-space: nowrap;',
            '}',
            '.modal-settings-close {',
            '  margin-left: auto;',
            '  background: none; border: none; color: #888;',
            '  cursor: pointer; font-size: 18px; padding: 0 4px;',
            '  line-height: 1;',
            '}',
            '.modal-settings-close:hover { color: #fff; }',
            '/* Corps */',
            '.modal-settings-body { padding: 20px; }',
            '.modal-settings-body section {',
            '  margin-bottom: 20px; padding-bottom: 20px;',
            '  border-bottom: 1px solid #3a3a3e;',
            '}',
            '.modal-settings-body section:last-child {',
            '  margin-bottom: 0; padding-bottom: 0;',
            '  border-bottom: none;',
            '}',
            '.modal-settings-body h3 {',
            '  margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #aaa;',
            '  text-transform: uppercase; letter-spacing: 0.5px;',
            '}',
            '/* Champs de formulaire */',
            '.modal-settings-body label {',
            '  display: block; margin: 8px 0 4px;',
            '  font-size: 12px; color: #999;',
            '}',
            '.modal-settings-body input[type="text"],',
            '.modal-settings-body input[type="password"] {',
            '  width: 100%; padding: 8px 10px; margin-bottom: 4px;',
            '  border: 1px solid #444; border-radius: 6px;',
            '  background: #1a1a1e; color: #e0e0e0;',
            '  font-size: 13px; box-sizing: border-box;',
            '  outline: none;',
            '}',
            '.modal-settings-body input:focus {',
            '  border-color: #6a6aff;',
            '}',
            '/* Boutons */',
            '.modal-btn {',
            '  display: inline-block; padding: 8px 16px; margin-top: 8px;',
            '  border: none; border-radius: 6px;',
            '  cursor: pointer; font-size: 13px; font-weight: 500;',
            '  transition: background 0.2s;',
            '}',
            '.modal-btn:disabled {',
            '  opacity: 0.6; cursor: not-allowed;',
            '}',
            '.modal-btn-primary {',
            '  background: #4a4aff; color: #fff;',
            '}',
            '.modal-btn-primary:hover:not(:disabled) {',
            '  background: #5a5aff;',
            '}',
            '.modal-btn-action {',
            '  background: #2d7d46; color: #fff;',
            '}',
            '.modal-btn-action:hover:not(:disabled) {',
            '  background: #3a9d56;',
            '}',
            '/* Statuts */',
            '.modal-status-row {',
            '  display: flex; justify-content: space-between; align-items: center;',
            '  padding: 8px 0;',
            '}',
            '.status-badge {',
            '  font-size: 12px; color: #aaa;',
            '}',
            '.modal-status-grid {',
            '  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;',
            '}',
            '.status-item {',
            '  padding: 8px 12px; background: #1a1a1e;',
            '  border-radius: 6px; font-size: 13px;',
            '}',
            '/* Bandeau d\'avertissement — auth Modal manquante */',
            '.modal-auth-warning {',
            '  background: #4a2b1d;',
            '  border: 1px solid #c0392b;',
            '  border-left: 4px solid #e74c3c;',
            '  border-radius: 6px;',
            '  color: #f5c6c0;',
            '  padding: 10px 12px;',
            '  margin-bottom: 12px;',
            '  font-size: 13px;',
            '  line-height: 1.5;',
            '}',
            '.modal-auth-warning strong {',
            '  color: #ffb3a7;',
            '}',
            '/* Bandeau « log périmé » : reprend la palette d\'alerte ci-dessus,',
            '   en ambre (ce n\'est pas une erreur mais un risque de confusion). */',
            '.modal-log-stale {',
            '  flex-shrink: 0; margin: 8px 18px 0;',
            '  background: #4a3a1d;',
            '  border: 1px solid #c08a2b;',
            '  border-left: 4px solid #f0a83c;',
            '  border-radius: 6px;',
            '  color: #f5dfb8;',
            '  padding: 8px 12px;',
            '  margin-bottom: 0;',
            '  font-size: 12px;',
            '  line-height: 1.45;',
            '}',
            '.modal-log-stale strong {',
            '  color: #ffcf8b;',
            '}',
            '/* Logs */',
            '.modal-log-output {',
            '  background: #111; color: #0f0;',
            '  padding: 12px; border-radius: 6px;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 12px; line-height: 1.4;',
            '  max-height: 300px; overflow-y: auto;',
            '  white-space: pre-wrap; word-break: break-all;',
            '}',
            '/* Scrollbar */',
            '.modal-settings-panel::-webkit-scrollbar,',
            '.modal-log-output::-webkit-scrollbar {',
            '  width: 6px;',
            '}',
            '.modal-settings-panel::-webkit-scrollbar-track,',
            '.modal-log-output::-webkit-scrollbar-track {',
            '  background: transparent;',
            '}',
            '.modal-settings-panel::-webkit-scrollbar-thumb,',
            '.modal-log-output::-webkit-scrollbar-thumb {',
            '  background: #555; border-radius: 3px;',
            '}',
            '',
            // ─── Plugins detection section ───
            '.modal-plugins-list {',
            '  max-height: 280px; overflow-y: auto;',
            '  border: 1px solid #3a3a3e; border-radius: 8px;',
            '  padding: 8px; margin-top: 8px; background: #1a1a1e;',
            '}',
            '.modal-plugin-item {',
            '  display: flex; align-items: flex-start; gap: 8px;',
            '  padding: 8px 6px; border-bottom: 1px solid #2e2e32;',
            '  cursor: pointer; transition: background 0.15s;',
            '}',
            '.modal-plugin-item:last-child { border-bottom: none; }',
            '.modal-plugin-item:hover { background: #252530; }',
            '.modal-plugin-item input[type="checkbox"] {',
            '  margin-top: 3px; flex-shrink: 0; cursor: pointer;',
            '  width: 16px; height: 16px; accent-color: #4a4aff;',
            '}',
            '.modal-plugin-item-content { flex: 1; min-width: 0; }',
            '.modal-plugin-item-name {',
            '  font-size: 13px; font-weight: 600; color: #e0e0e0;',
            '}',
            '.modal-plugin-item-url {',
            '  font-size: 11px; color: #777; word-break: break-all;',
            '  margin-top: 2px; font-family: "Courier New", monospace;',
            '}',
            '.modal-plugin-item-nogit {',
            '  font-size: 11px; color: #c0a030; margin-top: 2px;',
            '}',
            '.modal-plugin-actions {',
            '  display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;',
            '}',
            '.modal-plugin-note {',
            '  font-size: 11px; color: #888; margin-top: 10px;',
            '  padding: 8px 10px; background: #1e2a1e; border-radius: 6px;',
            '  border-left: 3px solid #4a8a4a;',
            '}',
            '.modal-plugin-loading {',
            '  font-size: 13px; color: #aaa; text-align: center;',
            '  padding: 24px;',
            '}',
            '.modal-plugin-empty {',
            '  font-size: 13px; color: #777; text-align: center;',
            '  padding: 20px; font-style: italic;',
            '}',
            '.modal-plugin-item-status {',
            '  font-size: 11px; margin-top: 3px;',
            '}',
            '.modal-plugin-item-status--installed { color: #6fce7f; }',
            '.modal-plugin-item-status--new { color: #ffc860; }',
            '.modal-plugin-item-status--removed { color: #e06c5a; }',
            '.modal-plugin-item-status--none { color: #777; }',
            '',
            // ─── Models detection section (reuses plugin styles) ───
            '.modal-models-list {',
            '  max-height: 280px; overflow-y: auto;',
            '  border: 1px solid #3a3a3e; border-radius: 8px;',
            '  padding: 8px; margin-top: 8px; background: #1a1a1e;',
            '}',
            '.modal-model-item {',
            '  display: flex; align-items: flex-start; gap: 8px;',
            '  padding: 8px 6px; border-bottom: 1px solid #2e2e32;',
            '  cursor: pointer; transition: background 0.15s;',
            '}',
            '.modal-model-item:last-child { border-bottom: none; }',
            '.modal-model-item:hover { background: #252530; }',
            '.modal-model-item input[type="checkbox"] {',
            '  margin-top: 3px; flex-shrink: 0; cursor: pointer;',
            '  width: 16px; height: 16px; accent-color: #4a8aff;',
            '}',
            '.modal-model-item-content { flex: 1; min-width: 0; }',
            '.modal-model-item-name {',
            '  font-size: 13px; font-weight: 600; color: #e0e0e0;',
            '  word-break: break-all;',
            '}',
            '.modal-model-item-info {',
            '  font-size: 11px; color: #777; margin-top: 2px;',
            '}',
            '',
            '',
            // ─── Layout 3 étapes (refonte de la modale) ───
            '/* Pastilles de statut du header */',
            '.modal-pills {',
            '  display: flex; align-items: center; gap: 8px; margin-left: 4px;',
            '  min-width: 0; overflow: hidden;',
            '}',
            '.modal-pill {',
            '  display: inline-flex; align-items: center; gap: 6px;',
            '  font-size: 11px; color: #aaa; white-space: nowrap;',
            '  background: #1a1a1e; border: 1px solid #38383d;',
            '  border-radius: 999px; padding: 3px 9px;',
            '}',
            '.modal-pill::before {',
            '  content: ""; width: 7px; height: 7px; border-radius: 50%;',
            '  background: #777; flex-shrink: 0;',
            '}',
            '.modal-pill.ok { color: #6fcf7f; border-color: #2f4a34; }',
            '.modal-pill.ok::before { background: #6fcf7f; }',
            '.modal-pill.warn { color: #e0a94a; border-color: #4a3f2a; }',
            '.modal-pill.warn::before { background: #e0a94a; }',
            '',
            '/* Barre « Connexion » repliable */',
            '.modal-prereq { flex-shrink: 0; border-bottom: 1px solid #3a3a3e; background: #232327; }',
            '.modal-prereq-head {',
            '  display: flex; align-items: center; gap: 10px;',
            '  height: 40px; padding: 0 18px;',
            '  cursor: pointer; user-select: none;',
            '}',
            '.modal-prereq-head:hover { background: #26262b; }',
            '.modal-chevron {',
            '  display: inline-block; font-size: 9px; color: #777;',
            '  transition: transform 0.15s ease;',
            '}',
            '.modal-prereq.open .modal-chevron { transform: rotate(90deg); }',
            '.modal-prereq-title {',
            '  font-size: 12px; font-weight: 600; color: #aaa;',
            '  text-transform: uppercase; letter-spacing: 0.5px;',
            '}',
            '.modal-prereq-api {',
            '  font-size: 12px; color: #e0e0e0; max-width: 42%;',
            '  font-family: "Courier New", monospace;',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}',
            '.modal-prereq-state {',
            '  font-size: 11px; color: #777; margin-left: auto; white-space: nowrap;',
            '}',
            '.modal-prereq-body { display: none; padding: 0 18px 16px; }',
            '.modal-prereq.open .modal-prereq-body {',
            '  display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px;',
            '}',
            '.modal-col { min-width: 0; }',
            '.modal-prereq-body label {',
            '  display: block; margin: 8px 0 4px; font-size: 11px; color: #999;',
            '}',
            '.modal-prereq-body input[type="text"],',
            '.modal-prereq-body input[type="password"] {',
            '  width: 100%; padding: 7px 10px; box-sizing: border-box;',
            '  border: 1px solid #3a3a3e; border-radius: 6px;',
            '  background: #1a1a1e; color: #e0e0e0; font-size: 12px; outline: none;',
            '}',
            '.modal-prereq-body input:focus { border-color: #4a4aff; }',
            '',
            '/* Grille des 3 étapes — HAUTEUR FIXE ET IDENTIQUE pour les trois cadres. */',
            '/* La hauteur des cadres ne dépend plus de leur contenu : elle est imposée par',
            '   grid-auto-rows ET reprise explicitement par chaque .modal-step (valeurs à',
            '   garder ÉGALES entre les deux règles — c\'est vérifié par les tests). */',
            '/* Pourquoi une hauteur FIXE et pas un simple min-height : le cadre contient',
            '   déjà un corps défilable (.modal-step-body : flex 1 + overflow-y auto) et une',
            '   tête/pied non compressibles, donc rien ne peut être écrasé ; un min-height',
            '   laisserait au contraire la grille se dimensionner sur le contenu (hauteurs',
            '   différentes d\'une étape à l\'autre, mise en page qui saute). Le contenu trop',
            '   long (aide, listes, bandeau d\'erreur, log) défile DANS le cadre au lieu de',
            '   l\'étirer. */',
            '/* flex: 0 0 auto : ouvrir « Connexion », agrandir les logs ou redimensionner le',
            '   panneau ne comprime plus la zone des étapes ; c\'est le panneau qui devient',
            '   défilable (overflow-y: auto sur .modal-settings-panel). */',
            '.modal-steps {',
            '  flex: 0 0 auto;',
            '  grid-auto-rows: 420px;',
            '  height: 420px;',
            '  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;',
            '  padding: 14px 18px;',
            '}',
            '.modal-step {',
            '  display: flex; flex-direction: column;',
            '  /* Hauteur imposée À TOUS les cadres (identique) : aucun contenu ne peut la',
            '     faire varier ; box-sizing évite que les 2 px de bordure la dépassent et',
            '     overflow: hidden garantit que rien ne s\'échappe du cadre. */',
            '  height: 420px; box-sizing: border-box; overflow: hidden;',
            '  min-height: 0; min-width: 0;',
            '  background: #232327; border: 1px solid #38383d; border-radius: 10px;',
            '}',
            '.modal-step-head {',
            '  flex-shrink: 0; display: flex; align-items: center; gap: 8px;',
            '  padding: 10px 12px; border-bottom: 1px solid #38383d;',
            '}',
            '.modal-step-num {',
            '  display: inline-flex; align-items: center; justify-content: center;',
            '  width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;',
            '  font-size: 11px; font-weight: 700;',
            '  background: #38383d; color: #aaa;',
            '}',
            '.modal-step-num.active { background: #4a4aff; color: #fff; }',
            '.modal-step-num.done { background: #2f4a34; color: #6fcf7f; }',
            '.modal-step-title { font-size: 13px; font-weight: 600; color: #e0e0e0; }',
            '.modal-step-badge {',
            '  margin-left: auto; padding: 2px 7px; border-radius: 999px;',
            '  font-size: 10px; white-space: nowrap;',
            '  background: #1a1a1e; border: 1px solid #38383d; color: #777;',
            '}',
            '.modal-step-badge.ok { color: #6fcf7f; border-color: #2f4a34; }',
            '.modal-step-badge.warn { color: #e0a94a; border-color: #4a3f2a; }',
            '/* Corps = la SEULE zone qui absorbe le contenu : il prend la place restante',
            '   dans la hauteur fixe du cadre et défile (overflow-y: auto). min-height: 0 est',
            '   indispensable : sans lui, un contenu long imposerait sa hauteur au cadre et',
            '   le ferait grandir. */',
            '.modal-step-body {',
            '  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;',
            '  display: flex; flex-direction: column; gap: 8px;',
            '  padding: 10px 12px;',
            '}',
            '',
            '/* Indicateur « il y a du contenu plus bas » (posé par attachScrollHint).',
            '   ANCRAGE : un élément collant de HAUTEUR NULLE, dernier enfant du',
            '   conteneur défilant. Hauteur nulle = il n\'ajoute RIEN au contenu',
            '   défilable ; `position: sticky` le colle au bas de la zone visible et il',
            '   devient le bloc conteneur du dégradé + du chevron (position absolue, qui',
            '   eux ne défilent donc pas avec le contenu — contrairement à un enfant',
            '   absolu d\'un conteneur défilant). Aucune couleur en dur : tokens du pack',
            '   avec repli sur la palette locale. */',
            '.modal-scroll-hint-anchor {',
            '  position: sticky; bottom: 0; z-index: 1;',
            '  flex: 0 0 auto; height: 0;',
            '  pointer-events: none;',
            '}',
            '/* Masqué par DÉFAUT : la classe d\'état .is-visible (posée en JS d\'après',
            '   scrollHeight/clientHeight/scrollTop) est la seule chose qui l\'affiche.',
            '   pointer-events: none : il ne capte JAMAIS un clic (ni sélection, ni',
            '   glisser de la poignée de redimensionnement). */',
            '.modal-scroll-hint {',
            '  position: absolute; left: 0; right: 0; bottom: 0; height: 26px;',
            '  display: none; align-items: flex-end; justify-content: center;',
            '  padding-bottom: 3px;',
            '  pointer-events: none; user-select: none; cursor: default;',
            '  color: var(--aih-text-secondary, #a0a0a0);',
            '  background: linear-gradient(to bottom, var(--aih-scroll-hint-from, rgba(26, 26, 30, 0)), var(--aih-scroll-hint-to, rgba(26, 26, 30, 0.92)));',
            '}',
            '.modal-scroll-hint.is-visible { display: flex; }',
            '.modal-scroll-hint svg { display: block; }',
            '/* Mouvement (chevron qui respire) UNIQUEMENT si l\'utilisateur accepte les',
            '   animations : avec prefers-reduced-motion: reduce, l\'indicateur reste',
            '   purement statique (aucune animation, aucune transition). */',
            '@media (prefers-reduced-motion: no-preference) {',
            '  .modal-scroll-hint.is-visible svg { animation: modal-scroll-hint-bob 1.8s ease-in-out infinite; }',
            '}',
            '@keyframes modal-scroll-hint-bob {',
            '  0%, 100% { transform: translateY(0); opacity: 0.7; }',
            '  50% { transform: translateY(3px); opacity: 1; }',
            '}',
            '@media (prefers-reduced-motion: reduce) {',
            '  .modal-scroll-hint,',
            '  .modal-scroll-hint.is-visible svg { animation: none; transition: none; }',
            '}',
            '.modal-step-foot {',
            '  flex-shrink: 0; display: flex; flex-direction: column; gap: 7px;',
            '  padding: 10px 12px; border-top: 1px solid #38383d;',
            '}',
            '',
            '/* Lignes d\'information dans une étape */',
            '.modal-hint { font-size: 11px; color: #777; line-height: 1.45; }',
            '.modal-row {',
            '  display: flex; align-items: center; justify-content: space-between; gap: 8px;',
            '  padding: 6px 8px; border-radius: 6px; background: #1a1a1e;',
            '  font-size: 12px; color: #aaa;',
            '}',
            '.modal-row .val, .status-item .val {',
            '  flex-shrink: 0; font-weight: 600; color: #e0e0e0; text-align: right;',
            '}',
            '.modal-row .val.ok, .status-item .val.ok { color: #6fcf7f; }',
            '.modal-row .val.warn, .status-item .val.warn { color: #e06a6a; }',
            '.modal-row .val.muted, .status-item .val.muted { color: #777; }',
            '.status-item {',
            '  display: flex; align-items: center; justify-content: space-between; gap: 8px;',
            '}',
            '.modal-divider { flex-shrink: 0; height: 1px; background: #38383d; margin: 2px 0; }',
            '',
            '/* Champ de formulaire dans une étape (ex. paquets pip supplémentaires) */',
            '.modal-field { display: flex; flex-direction: column; gap: 4px; }',
            '.modal-field-label { font-size: 11px; color: #999; }',
            '.modal-field-row { display: flex; gap: 6px; align-items: center; }',
            '.modal-field-row .modal-input { flex: 1; min-width: 0; }',
            '.modal-input {',
            '  width: 100%; padding: 6px 8px; box-sizing: border-box;',
            '  border: 1px solid #3a3a3e; border-radius: 6px;',
            '  background: #1a1a1e; color: #e0e0e0; font-size: 12px;',
            '  font-family: inherit; outline: none;',
            '}',
            '.modal-input:focus { border-color: #4a4aff; }',
            '',
            '/* Listes (nodes / modèles) */',
            '.modal-list {',
            '  flex: 1 1 auto; min-height: 100px; max-height: none; overflow-y: auto;',
            '  border: 1px solid #38383d; border-radius: 8px;',
            '  padding: 6px; background: #1a1a1e;',
            '}',
            '.modal-item {',
            '  display: flex; align-items: flex-start; gap: 8px;',
            '  padding: 6px 4px; border-bottom: 1px solid #2a2a2e; cursor: pointer;',
            '}',
            '.modal-item:last-child { border-bottom: none; }',
            '.modal-item:hover { background: #202027; }',
            '.modal-item input[type="checkbox"] {',
            '  margin-top: 2px; flex-shrink: 0; cursor: pointer;',
            '  width: 15px; height: 15px; accent-color: #4a4aff;',
            '}',
            '.modal-item-main { flex: 1; min-width: 0; }',
            '.modal-item-name {',
            '  font-size: 12px; font-weight: 600; color: #e0e0e0; word-break: break-all;',
            '}',
            '.modal-item-sub { font-size: 10px; color: #777; margin-top: 2px; }',
            '.modal-item-sub.installed { color: #6fcf7f; }',
            '.modal-item-sub.new { color: #e0a94a; }',
            '.modal-item-sub.removed { color: #e06a6a; }',
            '.modal-item-sub.none { color: #777; }',
            '',
            '/* Déclinaisons de boutons du nouveau layout */',
            '.modal-btn {',
            '  background: #2f2f36; color: #e0e0e0;',
            '  border: 1px solid #3f3f46;',
            '}',
            '.modal-btn:hover:not(:disabled) { background: #38383f; }',
            '.modal-btn--primary { background: #4a4aff; color: #fff; border-color: #4a4aff; }',
            '.modal-btn--primary:hover:not(:disabled) { background: #5a5aff; }',
            '.modal-btn--wide { width: 100%; margin-top: 0; }',
            '.modal-btn--sm { padding: 6px 10px; margin-top: 0; font-size: 12px; }',
            '.modal-btnrow { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 8px; }',
            '.modal-check {',
            '  display: flex; align-items: center; gap: 6px;',
            '  font-size: 11px; color: #999; cursor: pointer;',
            '}',
            '.modal-check input { margin: 0; accent-color: #4a4aff; cursor: pointer; }',
            '',
            '/* Logs toujours visibles, seule zone qui grandit au redimensionnement */',
            '.modal-logs {',
            '  flex: 1 1 auto; min-height: 150px; overflow: hidden;',
            '  display: flex; flex-direction: column;',
            '  border-top: 1px solid #3a3a3e; background: #1a1a1e;',
            '}',
            '/* Poignée de redimensionnement vertical (pleine largeur, bas du panneau) */',
            '.modal-resize-handle {',
            '  position: relative;',
            '  flex-shrink: 0; height: 10px; width: 100%;',
            '  cursor: ns-resize; background: #232327;',
            '  border-top: 1px solid #38383d;',
            '  border-radius: 0 0 12px 12px;',
            '  touch-action: none;',
            '}',
            '/* Petit grip centré : rend la poignée repérable au premier coup d\'œil. */',
            '.modal-resize-handle::after {',
            '  content: ""; position: absolute; left: 50%; top: 3px;',
            '  transform: translateX(-50%); width: 46px; height: 3px;',
            '  border-radius: 2px; background: #55555e;',
            '}',
            '.modal-resize-handle:hover,',
            '.modal-resize-handle.is-active { background: #2f2f3a; }',
            '.modal-resize-handle:hover::after,',
            '.modal-resize-handle.is-active::after { background: #4a4aff; }',
            '.modal-logs-head {',
            '  flex-shrink: 0; display: flex; align-items: center; gap: 10px;',
            '  padding: 6px 18px; border-bottom: 1px solid #38383d;',
            '}',
            '.modal-logs-title {',
            '  font-size: 11px; font-weight: 600; color: #aaa;',
            '  text-transform: uppercase; letter-spacing: 0.5px;',
            '}',
            '.modal-logs-live {',
            '  display: inline-flex; align-items: center; gap: 5px;',
            '  font-size: 10px; color: #6fcf7f;',
            '}',
            '.modal-logs-live::before {',
            '  content: ""; width: 6px; height: 6px; border-radius: 50%;',
            '  background: #6fcf7f; animation: modal-blink 1.4s ease-in-out infinite;',
            '}',
            '@keyframes modal-blink { 50% { opacity: 0.25; } }',
            '.modal-logs-count { margin-left: auto; font-size: 10px; color: #777; }',
            '/* Indicateur de progression : spinner + libellé + temps écoulé. */',
            '.modal-log-progress {',
            '  display: inline-flex; align-items: center; gap: 6px;',
            '  margin-left: 4px; min-width: 0; max-width: 56%;',
            '  font-size: 10px; color: #9fc4ff;',
            '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
            '}',
            '.modal-log-progress::before {',
            '  content: ""; flex-shrink: 0; width: 9px; height: 9px;',
            '  border: 2px solid rgba(159, 196, 255, 0.25);',
            '  border-radius: 50%; border-top-color: #9fc4ff;',
            '  animation: modal-spin 0.8s linear infinite;',
            '}',
            '/* Silence > 20 s : la sortie n\'arrive plus, peut-être bloqué. */',
            '.modal-log-progress.is-silent { color: #ffb454; }',
            '.modal-log-progress.is-silent::before {',
            '  border-color: rgba(255, 180, 84, 0.25); border-top-color: #ffb454;',
            '}',
            '.modal-logs-body {',
            '  flex: 1; min-height: 0; margin: 0; overflow-y: auto;',
            '  padding: 8px 18px; color: #9f9;',
            '  font-family: "Courier New", monospace; font-size: 11px; line-height: 1.45;',
            '  white-space: pre-wrap; word-break: break-all;',
            '}',
            '',
            '/* Écrans étroits : les étapes s\'empilent verticalement */',
            '@media (max-width: 900px) {',
            '  .modal-prereq.open .modal-prereq-body { grid-template-columns: 1fr; }',
            '  /* Étapes empilées : MÊME hauteur fixe pour chaque cadre (260 px), zone des',
            '     étapes bornée par la place disponible avec scroll interne — les cadres ne',
            '     s\'étirent donc ni sur le contenu ni les uns les autres. */',
            '  .modal-steps {',
            '    grid-template-columns: 1fr; overflow-y: auto;',
            '    grid-auto-rows: 260px;',
            '    height: auto; max-height: 55vh; min-height: 0;',
            '  }',
            '  .modal-step { height: 260px; }',
            '  .modal-logs { flex: 1 1 auto; min-height: 120px; }',
            '}',
            '',
            '/* Scrollbars fines des zones scrollables du nouveau layout */',
            '.modal-step-body::-webkit-scrollbar,',
            '.modal-list::-webkit-scrollbar,',
            '.modal-logs-body::-webkit-scrollbar { width: 8px; }',
            '.modal-step-body::-webkit-scrollbar-track,',
            '.modal-list::-webkit-scrollbar-track,',
            '.modal-logs-body::-webkit-scrollbar-track { background: transparent; }',
            '.modal-step-body::-webkit-scrollbar-thumb,',
            '.modal-list::-webkit-scrollbar-thumb,',
            '.modal-logs-body::-webkit-scrollbar-thumb {',
            '  background: #3a3a3e; border-radius: 4px;',
            '}',
            '',
            '#modal-queue-badge {',
            '  transition: border-color 0.3s, background 0.3s;',
            '}',
            '#modal-queue-badge:hover {',
            '  background: #252535;',
            '}',
        ].join('\n');
        document.head.appendChild(style);
        console.log('Modal Gateway: styles injectés');
    }

    // ─── Fonctions utilitaires ───────────────────────────────────────────────

    /**
     * Échappe les caractères HTML pour éviter les injections XSS.
     * @param {string} str - Chaîne à échapper.
     * @returns {string}
     */
    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /**
     * Renseigne la pastille d'état du header (`#pill-*`).
     * Le libellé est remplacé, la classe porte la couleur du point.
     * @param {string} id
     * @param {boolean} ok
     * @param {string} okText
     * @param {string} warnText
     */
    function setStatusPill(id, ok, okText, warnText) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = ok ? okText : warnText;
        el.className = 'modal-pill ' + (ok ? 'ok' : 'warn');
    }

    /**
     * Renseigne le badge d'une étape (`#stepN-badge`).
     * @param {string} id
     * @param {boolean} ok
     * @param {string} okText
     * @param {string} warnText
     */
    function setStepBadge(id, ok, okText, warnText) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = ok ? okText : warnText;
        el.className = 'modal-step-badge ' + (ok ? 'ok' : 'warn');
    }

    /**
     * Renseigne une ligne de statut (`div.status-item`).
     * Si la ligne contient un `<span class="val">` (nouveau layout), seule la
     * valeur est mise à jour afin de conserver le libellé ; sinon on écrit la
     * ligne complète (fallback).
     * @param {Element} el
     * @param {string} label
     * @param {boolean} ok
     */
    function setStatusValue(el, label, ok) {
        if (!el) return;
        var valEl = el.querySelector('.val');
        if (valEl) {
            valEl.textContent = ok ? '✅' : '❌';
            valEl.className = 'val ' + (ok ? 'ok' : 'warn');
        } else {
            el.textContent = label + ' : ' + (ok ? '✅' : '❌');
        }
    }

    /**
     * Renseigne un badge de DATE d'opération (« ⏳ Jamais » si la valeur est
     * absente).
     * @param {string} id - id de l'élément (`status-sync`, `status-deploy`…).
     * @param {string|null|undefined} value - date ISO de la dernière opération.
     */
    function setDateBadge(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = value ? '✅ ' + value : '⏳ Jamais';
        el.className = 'val ' + (value ? 'ok' : 'muted');
    }

    /**
     * Re-rend les badges de date des opérations (sync modèles / déploiement /
     * sync user) depuis la config renvoyée par GET /api/modal/config.
     *
     * Extrait de la construction de la modale pour pouvoir être rappelé SEUL :
     * seuls ces trois badges sont réécrits, donc la position de défilement et
     * les champs en cours de saisie sont préservés (aucun re-render global).
     *
     * @param {object} config - config de ComfyCH (clés `last_*`).
     */
    function renderOperationBadges(config) {
        var cfg = config || {};
        setDateBadge('status-sync', cfg.last_sync);
        setDateBadge('status-deploy', cfg.last_deploy);
        setDateBadge('status-user-sync', cfg.last_user_sync);
    }

    /**
     * Rafraîchit l'ÉTAT AFFICHÉ après la fin d'une opération (deploy / sync /
     * restart / build), SANS fermer ni rouvrir la modale.
     *
     * Pourquoi : le serveur n'écrit la date de l'opération qu'à la FIN (code 0),
     * donc une modale déjà ouverte gardait l'ancienne valeur (« ⏳ Jamais »)
     * jusqu'à sa réouverture. On relit la config et on ne réécrit que les
     * badges concernés (dates + pastilles + badges d'étapes + manifeste des
     * nodes) : le reste du DOM n'est pas touché.
     *
     * Sans élément affiché (modale fermée), chaque mise à jour est un no-op.
     *
     * @returns {Promise<void>}
     */
    async function refreshOperationState() {
        try {
            var resp = await fetch('/api/modal/config');
            if (resp.ok) {
                renderOperationBadges(await resp.json());
            }
        } catch (e) {
            // Réseau instable : l'état déjà affiché reste en place.
        }
        // Pastilles du header, badges d'étapes et bandeau d'auth.
        refreshStatus();
        // Badge + hint de l'étape 2 (nodes réellement présents sur le volume).
        await fetchInstalledNodes();
    }

    /**
     * Rafraîchit les indicateurs de statut dans la modale.
     */
    function refreshStatus() {
        fetch('/api/modal/status')
            .then(function (r) { return r.json(); })
            .then(function (status) {
                // Ordre imposé par le nouveau layout de l'étape 1 :
                // CLI, Authentifié, Volume, API configurée, Secret.
                var items = document.querySelectorAll('.status-item');
                if (items.length >= 5) {
                    setStatusValue(items[0], '🔧 Modal CLI', !!status.modal_installed);
                    setStatusValue(items[1], '🔐 Authentifié', !!status.modal_authenticated);
                    setStatusValue(items[2], '💾 Volume comfy-models', !!status.volume_exists);
                    setStatusValue(items[3], '🌐 API configurée', !!status.api_configured);
                    setStatusValue(items[4], '🔑 Secret Modal', !!status.secret_exists);
                }
                // Pastilles compactes du header
                setStatusPill('pill-connect', !!status.api_configured, 'Connecté', 'Non connecté');
                setStatusPill('pill-secret', !!status.secret_exists, 'Secret', 'Sans secret');
                setStatusPill('pill-volume', !!status.volume_exists, 'Volume', 'Sans volume');
                // Badges des étapes Build / Modèles
                setStepBadge('step1-badge', !!status.last_deploy,
                    '✅ déployé',
                    '⏳ jamais déployé');
                setStepBadge('step3-badge', !!status.last_sync,
                    '✅ synchronisé',
                    '⏳ jamais synchronisé');
                // Bandeau d'avertissement — masqué dès que l'auth Modal est présente
                var authWarning = document.getElementById('modal-auth-warning');
                if (authWarning) {
                    authWarning.style.display = status.modal_authenticated ? 'none' : 'block';
                }
            })
            .catch(function () {});
    }

    /**
     * Lance une opération (sync/deploy) et affiche les logs en direct via SSE.
     * @param {'sync'|'deploy'} operation
     */
    /**
     * Bouton déclencheur de chaque opération (les ids ne suivent pas le même
     * schéma pour sync/deploy et pour les opérations « user settings » /
     * « custom nodes »).
     */
    var OP_BUTTON_IDS = {
        sync: 'cfg-run-sync',
        deploy: 'cfg-run-deploy',
        'sync-user': 'cfg-sync-user',
        'sync-custom-nodes': 'cfg-sync-custom-nodes',
        'restart-worker': 'cfg-run-restart-worker',
    };

    /** Libellé d'opération utilisé dans les notifications. */
    var OP_LABELS = {
        sync: t('comfych.op.sync', 'Sync modèles'),
        deploy: t('comfych.op.deploy', 'Déploiement'),
        'sync-user': t('comfych.op.syncUser', 'Sync user settings'),
        'sync-custom-nodes': t('comfych.op.syncNodes', 'Sync custom nodes'),
        'restart-worker': t('comfych.op.restartWorker', 'Redémarrage du worker'),
    };

    /** Période (ms) de la vérification de l'état serveur pendant une opération. */
    var OP_STATUS_POLL_MS = 3000;

    /**
     * Durée (s) sans aucune ligne de log au-delà de laquelle on affiche un
     * avertissement de silence : « ça travaille sans rien dire » ou « bloqué ».
     */
    var OP_SILENCE_SECONDS = 20;

    /**
     * Traduit le nom d'opération renvoyé par le serveur (`sync_custom_nodes`)
     * en libellé lisible, en réutilisant OP_LABELS.
     * @param {string} name
     * @returns {string} Libellé, ou chaîne vide si `name` est vide.
     */
    function opLabelFromServer(name) {
        if (!name) return '';
        var slug = String(name).replace(/_/g, '-');
        return OP_LABELS[slug] || String(name);
    }

    /**
     * Manifeste connu des custom nodes réellement présents sur le volume
     * ``comfy-custom-nodes`` (source de vérité des badges « déjà installé »).
     * Rempli par fetchInstalledNodes() — jamais déduit de la sélection locale.
     * @type {{nodes: Array<string>, synced_at: (string|null), loaded: boolean}}
     */
    var installedNodesInfo = { nodes: [], synced_at: null, loaded: false };

    /**
     * Formate une date ISO en « JJ/MM HH:MM » (pour le hint de l'étape 2).
     * @param {string|null} iso
     * @returns {string} Chaîne vide si la date est absente/invalide.
     */
    function formatSyncDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /**
     * Met à jour le badge et le hint de l'étape 2 depuis installedNodesInfo.
     */
    function updateInstalledBadges() {
        var nodes = Array.isArray(installedNodesInfo.nodes) ? installedNodesInfo.nodes : [];
        setStepBadge('step2-badge', nodes.length > 0,
            nodes.length + ' node' + (nodes.length > 1 ? 's' : '') + ' installé' + (nodes.length > 1 ? 's' : ''),
            'non synchronisé');

        var hint = document.getElementById('step2-sync-hint');
        if (!hint) return;
        var when = formatSyncDate(installedNodesInfo.synced_at);
        if (!when && nodes.length === 0) {
            hint.style.display = 'none';
            return;
        }
        hint.textContent = 'Dernier sync : ' + (when || 'inconnue') +
            ' — ' + nodes.length + ' node(s) sur le volume comfy-custom-nodes.';
        hint.style.display = 'block';
    }

    /**
     * Charge le manifeste des nodes installés depuis le backend.
     * Lecture instantanée (config.json local, pas d'appel Modal).
     * @returns {Promise<{nodes: Array<string>, synced_at: (string|null), loaded: boolean}>}
     */
    async function fetchInstalledNodes() {
        try {
            var resp = await fetch('/api/modal/plugins/installed');
            if (resp.ok) {
                var data = await resp.json();
                installedNodesInfo = {
                    nodes: Array.isArray(data.nodes) ? data.nodes : [],
                    synced_at: data.synced_at || null,
                    loaded: true,
                };
            }
        } catch (e) {
            // Mode dégradé : on conserve le dernier manifeste connu.
            console.warn('Modal Gateway: manifeste des nodes indisponible', e);
        }
        updateInstalledBadges();
        return installedNodesInfo;
    }

    /**
     * Affiche/masque le bouton de secours « 🔓 Forcer la libération ».
     * @param {boolean} visible
     */
    function setForceReleaseVisible(visible) {
        var el = document.getElementById('modal-log-force-release');
        if (el) el.style.display = visible ? 'inline-block' : 'none';
    }

    /**
     * Formate l'âge d'un log en texte lisible.
     *
     * ``< 60 s`` → « à l'instant », ``< 60 min`` → « N min »,
     * ``< 24 h`` → « N h », au-delà → « N j ». Avec ``prefix``, on obtient la
     * forme relative « il y a N h » (ligne d'en-tête du log).
     * @param {*} seconds - ``age_seconds`` renvoyé par l'API (absent = '').
     * @param {boolean} [prefix=false] - Préfixer par « il y a ».
     * @returns {string} Texte de l'âge, ou '' si l'information manque
     *   (ancien backend sans ``age_seconds``).
     */
    function formatLogAge(seconds, prefix) {
        if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '';
        var text;
        if (seconds < 60) {
            text = 'à l\'instant';
        } else if (seconds < 3600) {
            text = Math.floor(seconds / 60) + ' min';
        } else if (seconds < 86400) {
            text = Math.floor(seconds / 3600) + ' h';
        } else {
            text = Math.floor(seconds / 86400) + ' j';
        }
        if (!prefix || seconds < 60) return text;
        return 'il y a ' + text;
    }

    /**
     * Affiche (ou masque) le bandeau « log périmé » au-dessus du log.
     *
     * Un ``modal deploy`` ne démarre aucun container : sans cet avertissement,
     * un log de 400 octets vieux de 7 h se lit comme « le nouveau code tourne ».
     * @param {string} message - Texte du bandeau ; chaîne vide = masqué.
     */
    function setLogStaleWarning(message) {
        var el = document.getElementById('modal-log-stale');
        if (!el) return;
        if (message) {
            el.textContent = message;
            el.style.display = 'block';
        } else {
            el.textContent = '';
            el.style.display = 'none';
        }
    }

    /**
     * Affiche les dernières lignes du log ComfyUI du worker Modal
     * (``GET /api/modal/worker-logs`` → ``{api_url}/logs``).
     *
     * Indépendant du SSE des opérations ``modal run`` : si une opération est en
     * cours, on prévient que son flux va écraser l'affichage (on ne touche pas
     * à l'EventSource en cours).
     * @param {number} [lines=300] - Nombre de lignes demandées.
     */
    async function showWorkerLogs(lines) {
        var logSection = document.getElementById('modal-log-section');
        var logOutput = document.getElementById('modal-log-output');
        var logCountEl = document.getElementById('modal-log-count');
        var progressEl = document.getElementById('modal-log-progress');
        var buttons = [
            document.getElementById('modal-log-worker-logs'),
            document.getElementById('cfg-worker-logs'),
        ].filter(Boolean);
        if (!logSection || !logOutput) return;

        var count = lines || 300;
        logSection.style.display = 'flex';
        buttons.forEach(function (b) { b.disabled = true; });

        // Une opération Modal tourne ? Son SSE réécrit le panneau à chaque ligne.
        var opRunning = !!(progressEl && progressEl.style.display !== 'none');
        var warning = '';
        if (opRunning) {
            warning = '⚠️ Une opération Modal est en cours : son flux de logs ' +
                'écrasera cet affichage.\n\n';
            showNotification(
                '⚠️ Opération en cours — l\'affichage des logs worker sera écrasé',
                'info'
            );
        }

        try {
            var resp = await fetch('/api/modal/worker-logs?lines=' + count);
            var data = {};
            try { data = await resp.json(); } catch (_) {}
            if (!resp.ok || data.ok === false) {
                throw new Error(data.error || ('HTTP ' + resp.status));
            }

            var tail = Array.isArray(data.lines) ? data.lines : [];
            var ageText = formatLogAge(data.age_seconds, true);
            var meta = '';
            if (data.path) {
                meta = '  ' + data.path +
                    (typeof data.size === 'number' ? ' — ' + data.size + ' octets' : '') +
                    (ageText ? ' · dernière écriture : ' + ageText : '');
            } else if (ageText) {
                meta = '  dernière écriture : ' + ageText;
            }

            // Péremption : plus d'une heure sans écriture = aucun container
            // n'a démarré depuis le dernier déploiement.
            if (typeof data.age_seconds === 'number' && data.age_seconds > 3600) {
                setLogStaleWarning(
                    '⚠️ Ce log date de ' + formatLogAge(data.age_seconds) +
                    ' : aucun container n\'a redémarré depuis. Lancez une ' +
                    'génération pour démarrer un worker avec le code actuel.'
                );
            } else {
                setLogStaleWarning('');
            }

            var body = tail.length ? tail.join('\n') : '(log vide)';
            var errorLine = data.error ? '❌ ' + data.error + '\n\n' : '';
            var text = warning + errorLine +
                '───── Logs worker (comfyui.log) ─────\n' +
                (meta ? meta + '\n' : '') +
                '────────────────────────────────────\n' +
                body;

            logOutput.textContent = text;
            logOutput.scrollTop = logOutput.scrollHeight;
            if (logCountEl) {
                logCountEl.textContent = tail.length + ' ligne' + (tail.length > 1 ? 's' : '');
            }
            if (data.error) {
                showNotification('⚠️ Logs worker : ' + data.error, 'error');
            }
        } catch (e) {
            setLogStaleWarning('');
            logOutput.textContent = warning +
                '❌ Logs worker indisponibles : ' + (e.message || 'erreur inconnue');
            if (logCountEl) logCountEl.textContent = '0 ligne';
            showNotification('❌ Logs worker indisponibles : ' + (e.message || ''), 'error');
        } finally {
            buttons.forEach(function (b) { b.disabled = false; });
        }
    }

    /**
     * Libère de force le slot d'opération Modal (POST /api/modal/op/reset).
     * Le subprocess Modal éventuellement encore vivant n'est PAS tué.
     */
    async function forceReleaseOperation() {
        var btn = document.getElementById('modal-log-force-release');
        var logOutput = document.getElementById('modal-log-output');
        if (btn) btn.disabled = true;
        try {
            var resp = await fetch('/api/modal/op/reset', { method: 'POST' });
            var data = {};
            try { data = await resp.json(); } catch (_) {}
            if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
            var msg = data.message || 'Slot d\'opération libéré';
            showNotification('🔓 ' + msg, 'success');
            if (logOutput) logOutput.textContent += '\n🔓 ' + msg + '\n';
            setForceReleaseVisible(false);
            refreshStatus();
        } catch (e) {
            showNotification('❌ Libération impossible : ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /**
     * Lance une opération (sync/deploy/redémarrage) et affiche les logs en
     * direct via SSE.
     *
     * @param {string} operation - Nom d'opération (= segment de la route).
     * @param {object} [options] - ``options.body`` : corps JSON à envoyer
     *   (ex. ``{render_in_progress, confirm}`` pour le redémarrage du worker).
     */
    async function runOperation(operation, options) {
        var requestOptions = { method: 'POST' };
        if (options && options.body) {
            requestOptions.headers = { 'Content-Type': 'application/json' };
            requestOptions.body = JSON.stringify(options.body);
        }
        var btnId = OP_BUTTON_IDS[operation] || ('cfg-run-' + operation);
        var btn = document.getElementById(btnId);
        var logSection = document.getElementById('modal-log-section');
        var logOutput = document.getElementById('modal-log-output');
        var logCountEl = document.getElementById('modal-log-count');
        var progressEl = document.getElementById('modal-log-progress');
        var logLines = 0;
        var opLabel = OP_LABELS[operation] || operation;

        if (!btn || !logSection || !logOutput) return;

        var originalLabel = btn.textContent;

        // ── État de l'indicateur de progression ──────────────────────────
        var t0 = Date.now();          // début de l'opération (horloge client)
        var lastLineAt = Date.now();  // date de la dernière ligne de log reçue
        var serverElapsed = 0;        // elapsed_seconds renvoyé par le serveur
        var serverOpLabel = '';       // libellé de l'op côté serveur (fiable)
        var progressTimer = null;     // tick 500 ms du texte de progression
        var statusTimer = null;       // tick 3 s de GET /api/modal/op/status
        var eventSource = null;
        var finished = false;

        /** Temps écoulé affiché : max(client, serveur) pour ne jamais reculer. */
        function elapsedSeconds() {
            var local = Math.floor((Date.now() - t0) / 1000);
            return Math.max(local, serverElapsed || 0);
        }

        /** Réécrit la zone de progression (le spinner est en CSS). */
        function renderProgress() {
            if (finished || !progressEl) return;
            var silentFor = Math.floor((Date.now() - lastLineAt) / 1000);
            var text = '⏳ ' + (serverOpLabel || opLabel) + ' — ' + elapsedSeconds() + 's';
            if (silentFor > OP_SILENCE_SECONDS) {
                text += ' · aucune sortie depuis ' + silentFor + 's';
            }
            progressEl.textContent = text;
            progressEl.classList.toggle('is-silent', silentFor > OP_SILENCE_SECONDS);
        }

        /** Démarre le compteur local + la surveillance de l'état serveur. */
        function startProgress() {
            if (progressEl) {
                progressEl.style.display = 'inline-flex';
                progressEl.textContent = '⏳ ' + opLabel + ' — 0s';
            }
            progressTimer = setInterval(renderProgress, 500);
            statusTimer = setInterval(pollOpStatus, OP_STATUS_POLL_MS);
        }

        /** Arrête et masque l'indicateur (idempotent). */
        function stopProgress() {
            finished = true;
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
            if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
            if (progressEl) {
                progressEl.style.display = 'none';
                progressEl.textContent = '';
                progressEl.classList.remove('is-silent');
            }
        }

        /** Ajoute une ligne au panneau de logs (autoscroll en bas). */
        function appendLogLine(line) {
            logOutput.textContent += line + '\n';
            logOutput.scrollTop = logOutput.scrollHeight;
        }

        /**
         * Filet de sécurité : toutes les 3 s, demander l'état du slot serveur.
         * - `in_progress === false` alors qu'on attend encore → l'opération est
         *   finie mais le SSE n'a pas signalé la fin (flux coupé, status perdu).
         * - sinon `operation` / `elapsed_seconds` corrigent le libellé et le
         *   temps écoulé (plus fiable qu'un compteur reparti de zéro après un
         *   rechargement de page).
         */
        async function pollOpStatus() {
            if (finished) return;
            try {
                var resp = await fetch('/api/modal/op/status');
                if (!resp.ok || finished) return;
                var st = await resp.json();
                if (finished) return;
                if (typeof st.elapsed_seconds === 'number') {
                    serverElapsed = st.elapsed_seconds;
                }
                var srvLabel = opLabelFromServer(st.operation);
                if (srvLabel) serverOpLabel = srvLabel;
                if (st.in_progress === false) finishFromServerStatus();
            } catch (_) { /* réseau instable : on retentera au tick suivant */ }
        }

        /** Conclut l'opération quand le serveur dit qu'elle n'est plus active. */
        function finishFromServerStatus() {
            if (finished) return;
            stopProgress();
            if (eventSource) {
                try { eventSource.close(); } catch (_) {}
                eventSource = null;
            }
            btn.disabled = false;
            btn.textContent = originalLabel;
            appendLogLine('ℹ️ Opération terminée (le flux de logs n\'a pas signalé la fin)');
            showNotification('ℹ️ ' + opLabel + ' terminé — voir logs', 'info');
            // État affiché (dates, statut, compteurs) remis à jour SANS
            // fermer/rouvrir la modale.
            setTimeout(refreshOperationState, 500);
        }

        btn.disabled = true;
        btn.textContent = '⏳ En cours...';
        // `.modal-logs` est un conteneur flex (head fixe + corps scrollable).
        logSection.style.display = 'flex';
        logOutput.textContent = '';
        // La sortie d'une opération remplace le log worker : l'avertissement
        // de péremption ne concerne plus ce qui s'affiche.
        setLogStaleWarning('');
        if (logCountEl) logCountEl.textContent = '0 ligne';

        try {
            // Lancer l'opération
            var opResp = await fetch('/api/modal/' + operation, requestOptions);

            // 409 : une autre opération occupe le slot. Message explicite
            // (laquelle, depuis combien de temps) + bouton de secours —
            // sinon l'utilisateur ne voit qu'un « déjà en cours » opaque.
            if (opResp.status === 409) {
                var busy = {};
                try { busy = await opResp.json(); } catch (_) {}
                var busyOp = busy.operation || 'inconnue';
                var busySecs = (typeof busy.elapsed_seconds === 'number') ? busy.elapsed_seconds : 0;
                var busyMsg = '⚠️ Opération « ' + busyOp + ' » en cours depuis ' +
                    busySecs + 's — attendez ou forcez la libération.';
                logSection.style.display = 'flex';
                logOutput.textContent = busyMsg + '\n' +
                    (busy.error || '') + '\n';
                showNotification(busyMsg, 'error');
                setForceReleaseVisible(true);
                btn.disabled = false;
                btn.textContent = originalLabel;
                return;
            }

            if (!opResp.ok) {
                var errText = '';
                try {
                    var errJson = await opResp.json();
                    errText = errJson.error || JSON.stringify(errJson);
                } catch (_) {
                    try { errText = await opResp.text(); } catch (_2) {}
                }
                throw new Error('HTTP ' + opResp.status + ' ' + errText);
            }

            // L'opération a bien été lancée : plus besoin du bouton de secours.
            setForceReleaseVisible(false);

            // Retour visuel immédiat (avant même la première ligne de log).
            startProgress();

            // Lire les logs en SSE
            eventSource = new EventSource('/api/modal/logs/stream');

            eventSource.onmessage = function (event) {
                try {
                    var data = JSON.parse(event.data);
                    if (data.line) {
                        logOutput.textContent += data.line + '\n';
                        logOutput.scrollTop = logOutput.scrollHeight;
                        logLines++;
                        if (logCountEl) {
                            logCountEl.textContent = logLines + ' ligne' + (logLines > 1 ? 's' : '');
                        }
                        // La sortie vit : remet à zéro le compteur de silence.
                        lastLineAt = Date.now();
                        renderProgress();
                    }
                } catch (e) {}
            };

            eventSource.addEventListener('done', function (event) {
                stopProgress();
                if (eventSource) eventSource.close();
                var data;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    data = { code: '1' };
                }
                btn.disabled = false;
                btn.textContent = data.code === '0' ? '✅ Terminé' : '❌ Échec';
                setTimeout(function () { btn.textContent = originalLabel; }, 2500);
                if (data.code === '0') {
                    showNotification(
                        '✅ ' + opLabel + ' réussi !',
                        'success'
                    );
                } else {
                    showNotification(
                        '❌ ' + opLabel + ' échoué — voir logs',
                        'error'
                    );
                }
                // Dans les DEUX cas : relire l'état (les dates ne changent
                // qu'en cas de succès, mais les indicateurs — volume, nodes
                // installés — peuvent avoir bougé). Uniquement les badges
                // concernés : ni le scroll ni les champs ne sont touchés.
                setTimeout(refreshOperationState, 1000);
            });

            eventSource.onerror = function () {
                stopProgress();
                if (eventSource) eventSource.close();
                btn.disabled = false;
                btn.textContent = '❌ Erreur connexion';
                setTimeout(function () { btn.textContent = originalLabel; }, 2500);
                logOutput.textContent += '\n⚠️ Connexion SSE perdue.\n';
            };

        } catch (e) {
            stopProgress();
            btn.disabled = false;
            btn.textContent = '❌ Erreur';
            setTimeout(function () { btn.textContent = originalLabel; }, 2500);
            logOutput.textContent = e.message || 'Erreur inconnue';
        }
    }

    /**
     * Extracts model filenames and class_types from the current ComfyUI workflow.
     * Returns {modelFiles: [...], classTypes: [...]} or null if unavailable.
     */
    async function getWorkflowInfo() {
        var appInstance = window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app);
        if (!appInstance) return null;

        try {
            // Try to get the API-format workflow
            var prompt = null;
            if (appInstance.graphToPrompt) {
                prompt = await appInstance.graphToPrompt();
            } else if (appInstance.graph && appInstance.graph.serialize) {
                // Fallback: can't easily get API format, return null
                return null;
            }

            if (!prompt || typeof prompt !== 'object') return null;

            // The prompt might be {output: {...}, workflow: {...}} (new format) or direct API format
            var apiPrompt = prompt.output || prompt;

            var modelFiles = [];
            var classTypes = [];
            var modelInputKeys = ['unet_name', 'model_name', 'clip_name', 'clip_name1', 'clip_name2',
                'vae_name', 'lora_name', 'control_net_name', 'upscale_model', 'checkpoint_name',
                'model_name', 'face_model', 'model_file', 'filename', 'embedding_name'];

            for (var nodeId in apiPrompt) {
                if (!Object.prototype.hasOwnProperty.call(apiPrompt, nodeId)) continue;
                var node = apiPrompt[nodeId];
                if (!node || typeof node !== 'object') continue;

                if (node.class_type) {
                    classTypes.push(node.class_type);
                }

                if (node.inputs) {
                    for (var key in node.inputs) {
                        if (!Object.prototype.hasOwnProperty.call(node.inputs, key)) continue;
                        var val = node.inputs[key];
                        if (typeof val === 'string' && val.length > 0) {
                            // Check if this input key looks like a model reference
                            var isModelKey = false;
                            for (var m = 0; m < modelInputKeys.length; m++) {
                                if (key === modelInputKeys[m] || key.endsWith('_name') || key.endsWith('_model')) {
                                    isModelKey = true;
                                    break;
                                }
                            }
                            if (isModelKey) {
                                modelFiles.push(val);
                            }
                        }
                    }
                }
            }

            return {modelFiles: modelFiles, classTypes: classTypes};
        } catch (e) {
            console.warn('Modal Gateway: could not extract workflow info', e);
            return null;
        }
    }

    // ─── Indicateur « il y a du contenu plus bas » ───────────────────────────

    /**
     * Marge (px) de tolérance avant de considérer qu'on est « arrivé en bas ».
     *
     * Elle sert AUSSI de seuil d'affichage : un débordement plus petit que cette
     * marge (arrondi de mise en page, gap résiduel de l'ancre) ne mérite pas un
     * indicateur — il ferait clignoter le chevron pour trois pixels cachés.
     * @type {number}
     */
    var SCROLL_HINT_MARGE = 12;

    /**
     * Ajoute à un conteneur DÉFILANT un indicateur discret « il y a du contenu
     * plus bas » : un dégradé subtil + un chevron `chevron-down` de la façade
     * `js/aih_icons.js` (jamais un emoji), affiché SEULEMENT s'il reste du
     * contenu sous la zone visible.
     *
     * Principe : l'élément ajouté est une ANCRE de hauteur nulle, en
     * `position: sticky; bottom: 0`, dernier enfant du conteneur. Elle ne
     * participe pas à la hauteur du contenu défilable, se colle au bas de la
     * zone visible et porte (en position absolue) le dégradé et le chevron —
     * ceux-ci ne défilent donc pas avec le contenu, ce qu'un enfant absolu d'un
     * conteneur défilant ferait. La visibilité est une CLASSE D'ÉTAT posée en JS
     * (jamais un `background-attachment: local` ou autre bidouille CSS) : elle
     * est donc observable et testable.
     *
     * Recalculs : au défilement du conteneur, au redimensionnement de la fenêtre,
     * au changement de taille de la zone (ResizeObserver) ET au changement de
     * contenu (MutationObserver : une opération ajoute des lignes de statut, un
     * log arrive…). Aucune hauteur n'est mémorisée : la géométrie est relue à
     * chaque fois, donc le zoom et le redimensionnement suivent tout seuls.
     *
     * L'indicateur est purement décoratif : `aria-hidden` (aucun sens porté par
     * une icône seule) et `pointer-events: none` — il n'intercepte jamais un clic,
     * ni la molette, ni le glisser d'une poignée placée dessous.
     *
     * @param {HTMLElement} scroller - Conteneur défilant (`overflow-y: auto`).
     * @param {{margin?: number}} [opts] - Marge de tolérance en px.
     * @returns {{el: HTMLElement, update: Function, destroy: Function}|null}
     *   Contrôleur, ou null si le conteneur n'est pas exploitable.
     */
    function attachScrollHint(scroller, opts) {
        var o = opts || {};
        if (!scroller || typeof scroller.appendChild !== 'function') return null;
        // Idempotent : rappeler la fonction sur le même conteneur rend le
        // contrôleur existant (jamais deux indicateurs dans le DOM).
        if (scroller.__aihScrollHint) return scroller.__aihScrollHint;

        var margin = (typeof o.margin === 'number' && o.margin >= 0)
            ? o.margin
            : SCROLL_HINT_MARGE;

        var anchor = document.createElement('div');
        anchor.className = 'modal-scroll-hint-anchor';
        anchor.setAttribute('aria-hidden', 'true');

        var hint = document.createElement('div');
        hint.className = 'modal-scroll-hint';
        hint.setAttribute('aria-hidden', 'true');
        hint.setAttribute('data-aih-icon', 'chevron-down');
        // Icône de la FAÇADE du pack. Nom inconnu → chaîne vide (dégradation
        // sûre) : le dégradé seul reste un indicateur acceptable.
        var chevron = aihIconSvg('chevron-down', { size: 14 });
        if (chevron) hint.innerHTML = chevron;

        anchor.appendChild(hint);
        scroller.appendChild(anchor);

        /** Géométrie relue à chaque fois (aucune hauteur mémorisée). */
        function geometry() {
            return {
                content: Number(scroller.scrollHeight) || 0,
                view: Number(scroller.clientHeight) || 0,
                top: Number(scroller.scrollTop) || 0,
            };
        }

        /**
         * Recalcule la visibilité de l'indicateur.
         * @returns {boolean} true si l'indicateur est affiché.
         */
        function update() {
            var g = geometry();
            // `view > 0` : conteneur réellement mis en page. Masqué (ou pas encore
            // mesuré), il n'y a rien à signaler.
            var overflowing = g.view > 0 && g.content > g.view + margin;
            var atEnd = (g.top + g.view) >= (g.content - margin);
            var visible = overflowing && !atEnd;
            // On ne touche au DOM que si l'état change (défilement = appel fréquent).
            if (hint.classList.contains('is-visible') !== visible) {
                hint.classList.toggle('is-visible', visible);
            }
            return visible;
        }

        function onScroll() { update(); }
        function onResize() { update(); }

        scroller.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize);

        // Changement de TAILLE de la zone (fenêtre, panneau redimensionné).
        var ro = null;
        if (typeof ResizeObserver === 'function') {
            try {
                ro = new ResizeObserver(onResize);
                ro.observe(scroller);
            } catch (_) { ro = null; }
        }
        // Changement de CONTENU (statut, log, liste re-rendue) : sans lui, le
        // chevron resterait absent alors que du contenu vient d'être ajouté.
        var mo = null;
        if (typeof MutationObserver === 'function') {
            try {
                mo = new MutationObserver(onResize);
                mo.observe(scroller, { childList: true, subtree: true, characterData: true });
            } catch (_) { mo = null; }
        }

        var handle = {
            el: hint,
            update: update,
            /** Retire l'indicateur et TOUS ses écouteurs (fermeture de la modale). */
            destroy: function () {
                try { scroller.removeEventListener('scroll', onScroll); } catch (_) {}
                try { window.removeEventListener('resize', onResize); } catch (_) {}
                if (ro) { try { ro.disconnect(); } catch (_) {} }
                if (mo) { try { mo.disconnect(); } catch (_) {} }
                if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
                try { delete scroller.__aihScrollHint; } catch (_) {}
            },
        };
        try { scroller.__aihScrollHint = handle; } catch (_) { /* DOM figé */ }
        update();
        return handle;
    }

    /**
     * Ouvre la modale de configuration Modal Gateway.
     * L'overlay est créé immédiatement (affichage instantané) puis rempli
     * en arrière-plan depuis /api/modal/config et /api/modal/status.
     */
    async function openSettingsModal() {
        // ── Verrou synchrone anti double-ouverture ──────────────────────
        if (window._modalSettingsOpen) return;
        if (document.getElementById('modal-settings-overlay')) return;
        window._modalSettingsOpen = true;

        // Config partagée avec les handlers (remplie en arrière-plan)
        var modalConfig = null;

        // ── Créer l'overlay IMMÉDIATEMENT (avant les fetches réseau) ─────
        var overlay = document.createElement('div');
        overlay.id = 'modal-settings-overlay';
        overlay.innerHTML = [
            '<div class="modal-settings-panel">',
            '  <div class="modal-settings-header">',
            '    <h2>⚙️ Modal Gateway</h2>',
            '    <div class="modal-pills">',
            '      <span class="modal-pill" id="pill-connect">…</span>',
            '      <span class="modal-pill" id="pill-secret">…</span>',
            '      <span class="modal-pill" id="pill-volume">…</span>',
            '    </div>',
            '    <button class="modal-settings-close" title="Fermer">✕</button>',
            '  </div>',
            '',
            '  <div class="modal-prereq" id="modal-prereq">',
            '    <div class="modal-prereq-head" id="modal-prereq-head">',
            '      <span class="modal-chevron">▶</span>',
            '      <span class="modal-prereq-title">Connexion</span>',
            '      <span class="modal-prereq-api" id="prereq-summary-api">…</span>',
            '      <span class="modal-prereq-state" id="prereq-summary-state">cliquer pour modifier</span>',
            '    </div>',
            '    <div class="modal-prereq-body">',
            '      <div class="modal-col">',
            '        <label for="cfg-api-url">URL de l\'API</label>',
            '        <input type="text" id="cfg-api-url" value="" placeholder="https://xxx.modal.run" />',
            '        <label for="cfg-api-key">Clé API (X-API-Key)</label>',
            '        <input type="password" id="cfg-api-key" value="" placeholder="Collez votre clé API" autocomplete="off" />',
            '        <div class="modal-btnrow">',
            '          <button id="cfg-generate-key" class="modal-btn modal-btn--sm">🔑 Générer</button>',
            '          <button id="cfg-create-secret" class="modal-btn modal-btn--sm">☁️ Créer le Secret</button>',
            '        </div>',
            '        <div id="cfg-secret-hint" class="modal-plugin-note">🔑 Cette clé protège votre endpoint /generate — n\'importe quelle chaîne aléatoire convient. Elle doit être identique dans le Secret Modal et ici.</div>',
            '      </div>',
            '      <div class="modal-col">',
            '        <label for="cfg-allowed-hosts">Hôtes autorisés (reverse proxy)</label>',
            '        <input type="text" id="cfg-allowed-hosts" value="" placeholder="comfy.example.com, autre.domaine" autocomplete="off" />',
            '        <label for="cfg-token-id">Token Modal — ID</label>',
            '        <input type="text" id="cfg-token-id" placeholder="ak-..." autocomplete="off" />',
            '        <label for="cfg-token-secret">Token Modal — Secret</label>',
            '        <input type="password" id="cfg-token-secret" placeholder="as-..." autocomplete="off" />',
            '        <div class="modal-btnrow">',
            '          <button id="cfg-save-token" class="modal-btn modal-btn--sm">✅ Enregistrer le token</button>',
            '          <button id="cfg-save-connection" class="modal-btn modal-btn--primary modal-btn--sm">💾 Sauvegarder</button>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </div>',
            '',
            '  <div class="modal-steps">',
            '    <div class="modal-step">',
            '      <div class="modal-step-head">',
            '        <span class="modal-step-num active">1</span>',
            '        <span class="modal-step-title">Build</span>',
            '        <span class="modal-step-badge" id="step1-badge">⏳</span>',
            '      </div>',
            '      <div class="modal-step-body">',
            '        <div id="modal-auth-warning" class="modal-auth-warning" style="display:none;">⚠️ <strong>Aucun token Modal actif</strong> — le déploiement échouera. Renseignez votre token dans « Connexion » puis cliquez sur « ✅ Enregistrer le token ».</div>',
            '        <div class="modal-hint">Construit l\'image Modal (nodes + modèles), y copie les user settings puis déploie le gateway API.</div>',
            '        <div class="modal-row"><span>🌐 Dernier déploiement</span><span class="val muted" id="status-deploy">⏳ Jamais</span></div>',
            '        <div class="modal-divider"></div>',
            '        <div class="modal-row status-item"><span>🔧 Modal CLI</span><span class="val muted">…</span></div>',
            '        <div class="modal-row status-item"><span>🔐 Authentifié</span><span class="val muted">…</span></div>',
            '        <div class="modal-row status-item"><span>💾 Volume comfy-models</span><span class="val muted">…</span></div>',
            '        <div class="modal-row status-item"><span>🌐 API configurée</span><span class="val muted">…</span></div>',
            '        <div class="modal-row status-item"><span>🔑 Secret Modal</span><span class="val muted">…</span></div>',
            // Dépendances OPTIONNELLES des custom nodes (ex. sageattention pour
            // kjnodes, mediapipe pour facetools) : absentes des requirements.txt
            // des nodes, installées au build en best-effort.
            '        <div class="modal-field">',
            '          <label class="modal-field-label" for="cfg-extra-pip">Paquets pip supplémentaires</label>',
            '          <div class="modal-field-row">',
            '            <input type="text" id="cfg-extra-pip" class="modal-input" value="" placeholder="sageattention, mediapipe, ultralytics" autocomplete="off" />',
            '            <button id="cfg-save-extra-pip" class="modal-btn modal-btn--sm" title="Enregistrer les paquets pip supplémentaires">💾</button>',
            '          </div>',
            '          <div class="modal-hint">Dépendances optionnelles des custom nodes (ex. sageattention pour kjnodes). Séparées par des virgules. Installées au déploiement — un échec n\'empêche pas le build.</div>',
            '        </div>',
            '        <div class="modal-divider"></div>',
            '        <div class="modal-row"><span>📁 User settings locaux</span><span class="val muted" id="status-user-settings">⏳ Vérification...</span></div>',
            '        <div class="modal-row"><span>🔄 Dernière sync user</span><span class="val muted" id="status-user-sync">⏳ Jamais</span></div>',
            // Le bouton de redémarrage (dans le PIED de l'étape, toujours visible)
            // ENCHAÎNE toujours sync → redémarrage : le worker ne recopie le volume
            // dans user/ qu'au démarrage du container (redémarrer d'abord relirait
            // l'ANCIEN volume). L'explication reste ici, dans le corps défilant.
            '        <div class="modal-hint">Les workflows, clés API et préférences UI sont copiés vers le volume : « 💾 Sync user settings » les envoie, puis « ♻️ Redémarrer le worker » (en bas de l\'étape) enchaîne une sync et l\'arrêt des containers — dans cet ordre, parce que le worker ne relit le volume <code>user/</code> qu\'au démarrage du container.</div>',
            '        <div class="modal-row"><span>🖥️ Logs du worker (ComfyUI)</span><span class="val"><button id="cfg-worker-logs" class="modal-btn modal-btn--sm" title="Tracebacks d\'import des custom nodes, dépendances manquantes, erreurs réseau">🖥️ Voir</button></span></div>',
            '      </div>',
            '      <div class="modal-step-foot">',
            '        <button id="cfg-run-deploy" class="modal-btn modal-btn--primary modal-btn--wide">🚀 Déployer</button>',
            '        <button id="cfg-sync-user" class="modal-btn modal-btn--wide">👤 Sync user settings</button>',
            // Redémarrage : action TERTIAIRE (sync puis arrêt des containers), d'où
            // `modal-btn--sm` ; pleine largeur (`--wide`) comme ses voisines pour ne
            // jamais déborder de la colonne, même en fenêtre étroite.
            '        <button id="cfg-run-restart-worker" class="modal-btn modal-btn--wide modal-btn--sm" title="Synchronise les fichiers locaux vers le volume, PUIS redémarre le worker (ordre imposé : le worker ne relit le volume qu\'au démarrage)">♻️ Redémarrer le worker</button>',
            '      </div>',
            '    </div>',
            '    <div class="modal-step">',
            '      <div class="modal-step-head">',
            '        <span class="modal-step-num active">2</span>',
            '        <span class="modal-step-title">Nodes</span>',
            '        <span class="modal-step-badge" id="step2-badge">⏳</span>',
            '      </div>',
            '      <div class="modal-step-body">',
            '        <div class="modal-hint">Détectez vos custom nodes locaux et synchronisez-les vers Modal. Un redeploy est nécessaire pour qu\'ils prennent effet.</div>',
            '        <div class="modal-hint" id="step2-sync-hint" style="display:none;"></div>',
            '        <div class="modal-btnrow">',
            '          <button id="cfg-detect-plugins" class="modal-btn modal-btn--sm">🔄 Détecter</button>',
            '          <a id="cfg-toggle-plugins" class="modal-btn modal-btn--sm" style="display:none;">☑ Tout</a>',
            '        </div>',
            '        <label class="modal-check"><input type="checkbox" id="cfg-plugins-workflow-only" /> Filtrer sur le workflow courant</label>',
            '        <div id="modal-plugins-loading" class="modal-plugin-loading" style="display:none;">⏳ Scan en cours...</div>',
            '        <div id="modal-plugins-empty" class="modal-plugin-empty" style="display:none;">Aucun node détecté.</div>',
            '        <div id="modal-plugins-list" class="modal-plugins-list modal-list" style="display:none;"></div>',
            '      </div>',
            '      <div class="modal-step-foot">',
            '        <button id="cfg-save-plugins" class="modal-btn modal-btn--wide" disabled>💾 Enregistrer la sélection</button>',
            '        <button id="cfg-sync-custom-nodes" class="modal-btn modal-btn--primary modal-btn--wide">📦 Sync vers Modal</button>',
            '      </div>',
            '    </div>',
            '    <div class="modal-step">',
            '      <div class="modal-step-head">',
            '        <span class="modal-step-num active">3</span>',
            '        <span class="modal-step-title">Modèles</span>',
            '        <span class="modal-step-badge" id="step3-badge">⏳</span>',
            '      </div>',
            '      <div class="modal-step-body">',
            '        <div class="modal-hint">Détectez vos modèles locaux et synchronisez-les vers le volume comfy-models de Modal.</div>',
            '        <div class="modal-btnrow">',
            '          <button id="cfg-detect-models" class="modal-btn modal-btn--sm">🔄 Détecter</button>',
            '          <a id="cfg-toggle-models" class="modal-btn modal-btn--sm" style="display:none;">☑ Tout</a>',
            '        </div>',
            '        <label class="modal-check"><input type="checkbox" id="cfg-models-workflow-only" /> Filtrer sur le workflow courant</label>',
            '        <div id="modal-models-loading" class="modal-plugin-loading" style="display:none;">⏳ Scan en cours...</div>',
            '        <div id="modal-models-empty" class="modal-plugin-empty" style="display:none;">Aucun modèle détecté.</div>',
            '        <div id="modal-models-list" class="modal-models-list modal-list" style="display:none;"></div>',
            '        <div class="modal-row"><span>🔄 Dernière sync modèles</span><span class="val muted" id="status-sync">⏳ Jamais</span></div>',
            '      </div>',
            '      <div class="modal-step-foot">',
            '        <button id="cfg-save-models" class="modal-btn modal-btn--wide" disabled>💾 Enregistrer la sélection</button>',
            '        <button id="cfg-run-sync" class="modal-btn modal-btn--primary modal-btn--wide">📥 Sync vers Modal</button>',
            '      </div>',
            '    </div>',
            '  </div>',
            '',
            '  <div class="modal-logs" id="modal-log-section">',
            '    <div class="modal-logs-head">',
            '      <span class="modal-logs-title">📋 Logs</span>',
            '      <span class="modal-logs-live">en direct</span>',
            '      <span id="modal-log-progress" class="modal-log-progress" style="display:none;"></span>',
            '      <span class="modal-logs-count" id="modal-log-count">0 ligne</span>',
            '      <button id="modal-log-force-release" class="modal-btn modal-btn--sm" style="display:none;margin:0 0 0 10px;" title="Libère le verrou d\'opération sans tuer le processus Modal en cours">🔓 Forcer la libération</button>',
            '      <button id="modal-log-worker-logs" class="modal-btn modal-btn--sm" style="margin:0 0 0 10px;" title="Affiche les dernières lignes du log ComfyUI du worker Modal (tracebacks des custom nodes)">🖥️ Logs worker</button>',
            '    </div>',
            '    <div id="modal-log-stale" class="modal-auth-warning modal-log-stale" style="display:none;" role="alert"></div>',
            '    <pre id="modal-log-output" class="modal-logs-body">─── Logs ───\nLancez une opération ou cliquez sur « 🖥️ Logs worker » pour voir les logs du worker.</pre>',
            '  </div>',
            '  <div class="modal-resize-handle" id="modal-resize-handle" title="Glisser pour agrandir la zone de logs"></div>',
            '</div>',
        ].join('\n');
        document.body.appendChild(overlay);

        // ── Make modal draggable by header ──
        var panel = overlay.querySelector('.modal-settings-panel');
        var header = overlay.querySelector('.modal-settings-header');
        var isDragging = false;
        var dragOffsetX = 0;
        var dragOffsetY = 0;

        // ── Indicateur « il y a du contenu plus bas » ────────────────────
        // Posé sur CHAQUE zone défilante de la modale : les 3 corps d'étape
        // (une colonne = un corps) et, en dernier recours, le panneau lui-même
        // (il ne défile que si la hauteur choisie ne suffit plus). Les
        // contrôleurs sont détruits à la fermeture : écouteurs et observateurs
        // ne survivent pas à l'overlay.
        var scrollHints = [];
        var hintTargets = overlay.querySelectorAll('.modal-step-body');
        for (var hintIdx = 0; hintIdx < hintTargets.length; hintIdx++) {
            var hintCtl = attachScrollHint(hintTargets[hintIdx]);
            if (hintCtl) scrollHints.push(hintCtl);
        }
        if (panel) {
            var panelHintCtl = attachScrollHint(panel);
            if (panelHintCtl) scrollHints.push(panelHintCtl);
        }

        /** Retire les indicateurs et leurs écouteurs (fermeture de la modale). */
        function detachScrollHints() {
            for (var i = 0; i < scrollHints.length; i++) {
                try { scrollHints[i].destroy(); } catch (_) { /* déjà retiré */ }
            }
            scrollHints = [];
        }

        // Handlers document nommés : ils sont retirés à la fermeture de la
        // modale, sinon chaque ouverture laisse deux listeners orphelins qui
        // retiennent panel/overlay détachés (fuite mémoire).
        function onModalDragMove(e) {
            if (!isDragging || !panel) return;
            var x = e.clientX - dragOffsetX;
            var y = e.clientY - dragOffsetY;
            // Keep within viewport bounds
            x = Math.max(0, Math.min(x, window.innerWidth - 100));
            y = Math.max(0, Math.min(y, window.innerHeight - 50));
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
        }

        function onModalDragUp() {
            isDragging = false;
        }

        function detachModalDragListeners() {
            document.removeEventListener('mousemove', onModalDragMove);
            document.removeEventListener('mouseup', onModalDragUp);
        }

        // ── Redimensionnement vertical de la modale (poignée du bas) ──────
        // Seule la hauteur change (jamais la largeur) : les étapes au-dessus
        // gardent leur hauteur et c'est la zone de logs qui absorbe l'écart.
        // Handlers document nommés + détachés à la fermeture : même précaution
        // que le drag du header (fuite de listeners sinon).
        var PANEL_HEIGHT_KEY = 'modal-panel-height';
        var PANEL_MIN_HEIGHT = 480;
        var isResizingPanel = false;
        var resizeStartY = 0;
        var resizeStartHeight = 0;

        /** Hauteur max : la modale doit rester dans la fenêtre. */
        function maxPanelHeight() {
            return Math.max(PANEL_MIN_HEIGHT, window.innerHeight - 40);
        }

        /** Applique une hauteur (bornée) au panneau. */
        function applyPanelHeight(height) {
            if (!panel) return;
            var clamped = Math.max(PANEL_MIN_HEIGHT, Math.min(height, maxPanelHeight()));
            panel.style.height = clamped + 'px';
        }

        function onPanelResizeMove(e) {
            if (!isResizingPanel || !panel) return;
            applyPanelHeight(resizeStartHeight + (e.clientY - resizeStartY));
            e.preventDefault();
        }

        function onPanelResizeUp() {
            if (!isResizingPanel) return;
            isResizingPanel = false;
            document.body.style.userSelect = '';
            var handle = document.getElementById('modal-resize-handle');
            if (handle) handle.classList.remove('is-active');
            // Mémorise la hauteur choisie pour la prochaine ouverture.
            if (panel) {
                try {
                    window.localStorage.setItem(
                        PANEL_HEIGHT_KEY,
                        String(Math.round(panel.getBoundingClientRect().height))
                    );
                } catch (_) { /* localStorage indisponible (mode privé) */ }
            }
        }

        function detachPanelResizeListeners() {
            document.removeEventListener('mousemove', onPanelResizeMove);
            document.removeEventListener('mouseup', onPanelResizeUp);
        }

        // Hauteur restaurée depuis la session précédente.
        if (panel) {
            var storedHeight = 0;
            try {
                storedHeight = parseInt(window.localStorage.getItem(PANEL_HEIGHT_KEY), 10) || 0;
            } catch (_) { /* localStorage indisponible */ }
            if (storedHeight > 0) applyPanelHeight(storedHeight);
        }

        // Gestionnaires d'événements
        overlay.querySelector('.modal-settings-close').onclick = function () {
            detachModalDragListeners();
            detachPanelResizeListeners();
            detachScrollHints();
            window._modalSettingsOpen = false;
            overlay.remove();
        };

        // Bouton de secours — n'apparaît qu'en cas de 409 (voir runOperation).
        var forceReleaseBtn = document.getElementById('modal-log-force-release');
        if (forceReleaseBtn) forceReleaseBtn.onclick = forceReleaseOperation;

        // Logs ComfyUI du worker Modal (diagnostic des custom nodes).
        var workerLogsBtn = document.getElementById('modal-log-worker-logs');
        if (workerLogsBtn) workerLogsBtn.onclick = function () { showWorkerLogs(300); };
        var workerLogsLink = document.getElementById('cfg-worker-logs');
        if (workerLogsLink) workerLogsLink.onclick = function () { showWorkerLogs(300); };
        // NOTE: clicking on the overlay background no longer closes the modal
        // overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

        if (header && panel) {
            header.style.cursor = 'move';
            header.style.userSelect = 'none';

            header.addEventListener('mousedown', function (e) {
                // Don't start drag if clicking the close button
                if (e.target.classList.contains('modal-settings-close')) return;
                isDragging = true;
                var rect = panel.getBoundingClientRect();
                dragOffsetX = e.clientX - rect.left;
                dragOffsetY = e.clientY - rect.top;
                panel.style.position = 'fixed';
                panel.style.left = rect.left + 'px';
                panel.style.top = rect.top + 'px';
                panel.style.transform = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', onModalDragMove);
            document.addEventListener('mouseup', onModalDragUp);
        }

        // ── Poignée de redimensionnement (bas du panneau) ────────────────
        var resizeHandle = document.getElementById('modal-resize-handle');
        if (resizeHandle && panel) {
            resizeHandle.addEventListener('mousedown', function (e) {
                isResizingPanel = true;
                resizeStartY = e.clientY;
                resizeStartHeight = panel.getBoundingClientRect().height;
                document.body.style.userSelect = 'none';
                resizeHandle.classList.add('is-active');
                document.addEventListener('mousemove', onPanelResizeMove);
                document.addEventListener('mouseup', onPanelResizeUp);
                e.preventDefault();
            });
            // Double-clic : retour à la hauteur par défaut du CSS.
            resizeHandle.addEventListener('dblclick', function () {
                panel.style.height = '';
                try { window.localStorage.removeItem(PANEL_HEIGHT_KEY); } catch (_) {}
            });
        }

        // ── Barre « Connexion » repliable ────────────────────────────────
        var prereqBar = document.getElementById('modal-prereq');
        var prereqHead = document.getElementById('modal-prereq-head');
        if (prereqBar && prereqHead) {
            prereqHead.onclick = function (e) {
                // Ne pas replier si l'utilisateur interagit avec un contrôle
                var target = e && e.target;
                if (target && target.closest && target.closest('input, button, a, select, textarea, label')) return;
                prereqBar.classList.toggle('open');
            };
        }

        /**
         * Met à jour le résumé de la barre « Connexion » (URL + état).
         * Appelé après le chargement de la config et après chaque sauvegarde.
         */
        function updatePrereqSummary() {
            var apiUrlInput = document.getElementById('cfg-api-url');
            var hostsInput = document.getElementById('cfg-allowed-hosts');
            var apiSummary = document.getElementById('prereq-summary-api');
            var stateSummary = document.getElementById('prereq-summary-state');

            var url = apiUrlInput ? (apiUrlInput.value || '').trim() : '';
            if (apiSummary) apiSummary.textContent = url || 'URL non configurée';

            var hosts = (hostsInput && hostsInput.value ? hostsInput.value : '')
                .split(',')
                .map(function (h) { return h.trim(); })
                .filter(function (h) { return h.length > 0; });

            if (stateSummary) {
                var parts = [];
                parts.push(window._apiKeySet ? 'clé enregistrée' : 'sans clé');
                parts.push(hosts.length + ' hôte' + (hosts.length > 1 ? 's' : '') + ' proxy');
                stateSummary.textContent = parts.join(' · ') + ' — cliquer pour modifier';
            }
        }

        document.getElementById('cfg-save-connection').onclick = async function () {
            var apiUrl = document.getElementById('cfg-api-url').value.trim();
            var apiKey = document.getElementById('cfg-api-key').value.trim();
            // Le serveur ne renvoie plus la clé en clair : un champ vide alors
            // qu'une clé est déjà enregistrée signifie « conserver l'existante ».
            var keepStoredKey = !apiKey && !!window._apiKeySet;
            var allowedHosts = (document.getElementById('cfg-allowed-hosts').value || '')
                .split(',')
                .map(function (h) { return h.trim(); })
                .filter(function (h) { return h.length > 0; });
            try {
                var payload = {
                    api_url: apiUrl,
                    allowed_hosts: allowedHosts,
                };
                // Ne PAS envoyer une clé vide : cela écraserait la clé stockée.
                if (apiKey) payload.api_key = apiKey;
                var saveResp = await fetch('/api/modal/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!saveResp.ok) {
                    throw new Error('HTTP ' + saveResp.status);
                }
                // Mettre à jour les constantes
                CONFIG.API_URL = apiUrl;
                if (apiUrl) localStorage.setItem('modal-api-url', apiUrl);
                if (apiKey) {
                    CONFIG.API_KEY = apiKey;
                    window._apiKeySet = true;
                    localStorage.setItem('modal-api-key', apiKey);
                } else if (!keepStoredKey) {
                    // Aucune clé enregistrée et champ vide → rien à conserver.
                    CONFIG.API_KEY = '';
                    window._apiKeySet = false;
                    localStorage.removeItem('modal-api-key');
                }
                // La clé déjà enregistrée reste utilisée (localStorage).
                updatePrereqSummary();
                updateSecretHint();
                refreshStatus();
                showNotification('✅ Configuration sauvegardée', 'success');
            } catch (e) {
                showNotification('❌ Erreur lors de la sauvegarde : ' + e.message, 'error');
            }
        };

        // ── Clé API : génération + hint CLI en direct ──
        var apiKeyInput = document.getElementById('cfg-api-key');
        var secretHint = document.getElementById('cfg-secret-hint');

        function updateSecretHint() {
            var key = apiKeyInput.value.trim();
            if (key) {
                secretHint.textContent = '🔑 Créez le Secret Modal "comfy-gateway-secret" (variable API_KEY) sur le site Modal (Dashboard → Secrets) ou en CLI : modal secret create comfy-gateway-secret API_KEY=' + key +
                    ' — puis redéployez (🚀 Deploy API). La clé du Secret et celle ici doivent être identiques.';
            } else if (window._apiKeySet) {
                secretHint.textContent = '🔑 Une clé est déjà enregistrée côté serveur. Laissez ce champ vide pour la conserver, ou saisissez une nouvelle clé pour la remplacer.';
            } else {
                secretHint.textContent = '🔑 Cette clé protège votre endpoint /generate — n\'importe quelle chaîne aléatoire convient (générez-en une ou collez un mot de passe). Elle doit être identique dans le Secret Modal et ici.';
            }
        }
        apiKeyInput.addEventListener('input', updateSecretHint);

        document.getElementById('cfg-generate-key').onclick = function () {
            var arr = new Uint8Array(24);
            if (window.crypto && crypto.getRandomValues) {
                crypto.getRandomValues(arr);
            } else {
                for (var gi = 0; gi < arr.length; gi++) arr[gi] = Math.floor(Math.random() * 256);
            }
            var key = '';
            for (var gi = 0; gi < arr.length; gi++) key += arr[gi].toString(16).padStart(2, '0');
            apiKeyInput.value = key;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(key).catch(function () {});
            }
            updateSecretHint();
            showNotification('🔑 Clé générée (48 hex). Créez le Secret Modal avec la commande affichée, puis collez-la ici.', 'info');
        };

        // ── Secret Modal : création / mise à jour depuis l'UI ──
        document.getElementById('cfg-create-secret').onclick = async function () {
            var apiKey = document.getElementById('cfg-api-key').value.trim();
            if (!apiKey) {
                // La clé existante n'est pas récupérable : il faut la ressaisir.
                if (window._apiKeySet) {
                    showNotification('⚠️ La clé enregistrée n\'est pas réaffichable : ressaisissez-la pour recréer le Secret Modal', 'error');
                } else {
                    showNotification('⚠️ Saisissez d\'abord une Clé API dans le champ ci-dessus (ou générez-en une)', 'error');
                }
                return;
            }
            var btn = document.getElementById('cfg-create-secret');
            btn.disabled = true;
            btn.textContent = '⏳ Création du Secret...';
            try {
                var resp = await fetch('/api/modal/secret', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_key: apiKey }),
                });
                var data = {};
                try { data = await resp.json(); } catch (_) {}
                if (!resp.ok || !data.ok) {
                    throw new Error(data.error || ('HTTP ' + resp.status));
                }
                showNotification('✅ Secret Modal créé/mis à jour — redéployez (🚀 Deploy API)', 'success');
                refreshStatus();
            } catch (e) {
                showNotification('❌ ' + e.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = '☁️ Créer/Mettre à jour le Secret sur Modal';
            }
        };

        updateSecretHint();

        // ─── Token Modal : enregistrement (remplace modal token set en CLI) ───
        document.getElementById('cfg-save-token').onclick = async function () {
            var tokenId = document.getElementById('cfg-token-id').value.trim();
            var tokenSecret = document.getElementById('cfg-token-secret').value.trim();
            if (!tokenId || !tokenSecret) {
                showNotification('⚠️ Renseignez le Token ID et le Token Secret (site Modal → Settings → API Tokens)', 'error');
                return;
            }
            var btn = document.getElementById('cfg-save-token');
            btn.disabled = true;
            btn.textContent = '⏳ Enregistrement + vérification...';
            try {
                var resp = await fetch('/api/modal/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token_id: tokenId, token_secret: tokenSecret }),
                });
                var data = {};
                try { data = await resp.json(); } catch (_) {}
                if (!resp.ok || !data.ok) {
                    throw new Error(data.error || ('HTTP ' + resp.status));
                }
                showNotification(
                    '✅ Token Modal enregistré' + (data.authenticated ? ' — connexion vérifiée ✅' : ' — vérifiez le statut ci-dessous'),
                    'success'
                );
                document.getElementById('cfg-token-id').value = '';
                document.getElementById('cfg-token-secret').value = '';
                refreshStatus();
            } catch (e) {
                showNotification('❌ ' + e.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = '✅ Enregistrer le token';
            }
        };

        document.getElementById('cfg-run-sync').onclick = function () { runOperation('sync'); };
        document.getElementById('cfg-run-deploy').onclick = function () { runOperation('deploy'); };

        var detectedPlugins = [];
        var savedPlugins = null;

        document.getElementById('cfg-detect-plugins').onclick = async function () {
            var btn = document.getElementById('cfg-detect-plugins');
            var listEl = document.getElementById('modal-plugins-list');
            var loadingEl = document.getElementById('modal-plugins-loading');
            var emptyEl = document.getElementById('modal-plugins-empty');
            var saveBtn = document.getElementById('cfg-save-plugins');

            btn.disabled = true;
            btn.textContent = '⏳ Scan...';
            listEl.style.display = 'none';
            emptyEl.style.display = 'none';
            loadingEl.style.display = 'block';

            try {
                if (savedPlugins === null) {
                    try {
                        var savedResp = await fetch('/api/modal/plugins');
                        if (savedResp.ok) {
                            savedPlugins = await savedResp.json();
                        } else {
                            savedPlugins = { custom_nodes: [], custom_nodes_ext: [], custom_nodes_local: [] };
                        }
                    } catch (e) {
                        savedPlugins = { custom_nodes: [], custom_nodes_ext: [], custom_nodes_local: [] };
                    }
                }

                var resp = await fetch('/api/modal/plugins/detect');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                var data = await resp.json();
                detectedPlugins = data.plugins || [];

                loadingEl.style.display = 'none';
                btn.disabled = false;
                btn.textContent = '🔄 Détecter mes nodes';

                if (detectedPlugins.length === 0) {
                    emptyEl.style.display = 'block';
                    saveBtn.disabled = true;
                    return;
                }

                var savedExtUrls = {};
                if (savedPlugins && savedPlugins.custom_nodes_ext) {
                    for (var s = 0; s < savedPlugins.custom_nodes_ext.length; s++) {
                        var p = savedPlugins.custom_nodes_ext[s];
                        if (p.url) savedExtUrls[p.url] = p;
                    }
                }

                // Nodes réellement présents sur le volume comfy-custom-nodes
                // (GET /api/modal/plugins/installed) — PAS la sélection en
                // config : depuis le refactor hybride le code des nodes vit
                // dans le volume, seule source de vérité fiable.
                await fetchInstalledNodes();
                var deployedSet = {};
                var installedList = Array.isArray(installedNodesInfo.nodes) ? installedNodesInfo.nodes : [];
                for (var d = 0; d < installedList.length; d++) {
                    deployedSet[installedList[d]] = true;
                }

                listEl.innerHTML = '';
                for (var i = 0; i < detectedPlugins.length; i++) {
                    (function (plugin) {
                        var item = document.createElement('label');
                        item.className = 'modal-plugin-item';

                        var checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.dataset.pluginName = plugin.name;
                        checkbox.dataset.pluginUrl = plugin.git_url || '';
                        if (plugin.git_url && savedExtUrls[plugin.git_url]) {
                            checkbox.checked = true;
                        }

                        // Pre-check local nodes from saved config
                        if (!plugin.has_git && savedPlugins && savedPlugins.custom_nodes_local) {
                            if (savedPlugins.custom_nodes_local.indexOf(plugin.name) !== -1) {
                                checkbox.checked = true;
                            }
                        }

                        var content = document.createElement('div');
                        content.className = 'modal-plugin-item-content';

                        var nameEl = document.createElement('div');
                        nameEl.className = 'modal-plugin-item-name';
                        nameEl.textContent = plugin.name;
                        content.appendChild(nameEl);

                        // Badge de statut installé / sera installé / sera retiré
                        var statusEl = document.createElement('div');
                        statusEl.className = 'modal-plugin-item-status';

                        function updatePluginStatus() {
                            var isDeployed = !!deployedSet[plugin.name];
                            if (checkbox.checked && isDeployed) {
                                statusEl.textContent = '✅ déjà installé';
                                statusEl.className = 'modal-plugin-item-status modal-plugin-item-status--installed';
                            } else if (checkbox.checked && !isDeployed) {
                                statusEl.textContent = '🆕 sera installé';
                                statusEl.className = 'modal-plugin-item-status modal-plugin-item-status--new';
                            } else if (!checkbox.checked && isDeployed) {
                                statusEl.textContent = '🗑️ sera retiré';
                                statusEl.className = 'modal-plugin-item-status modal-plugin-item-status--removed';
                            } else {
                                statusEl.textContent = '—';
                                statusEl.className = 'modal-plugin-item-status modal-plugin-item-status--none';
                            }
                        }
                        checkbox.addEventListener('change', updatePluginStatus);
                        content.appendChild(statusEl);
                        updatePluginStatus();

                        checkbox.dataset.pluginIsLocal = 'false';
                        if (plugin.has_git && plugin.git_url) {
                            var urlEl = document.createElement('div');
                            urlEl.className = 'modal-plugin-item-url';
                            urlEl.textContent = plugin.git_url;
                            content.appendChild(urlEl);
                        } else {
                            checkbox.dataset.pluginIsLocal = 'true';
                            var noGitEl = document.createElement('div');
                            noGitEl.className = 'modal-plugin-item-nogit';
                            noGitEl.textContent = '📁 Node local — sera copié dans l\'image Modal';
                            content.appendChild(noGitEl);
                        }

                        item.appendChild(checkbox);
                        item.appendChild(content);
                        listEl.appendChild(item);
                    })(detectedPlugins[i]);
                }

                var toggleBtn = document.getElementById('cfg-toggle-plugins');
                toggleBtn.style.display = 'inline-block';
                toggleBtn.textContent = 'Tout sélectionner';
                var allChecked = false;
                toggleBtn.onclick = function () {
                    allChecked = !allChecked;
                    var cbs = listEl.querySelectorAll('input[type="checkbox"]:not([disabled])');
                    for (var t = 0; t < cbs.length; t++) {
                        cbs[t].checked = allChecked;
                        cbs[t].dispatchEvent(new Event('change'));
                    }
                    toggleBtn.textContent = allChecked ? 'Tout désélectionner' : 'Tout sélectionner';
                };

                // Filter by workflow if enabled
                var pluginsWorkflowOnly = document.getElementById('cfg-plugins-workflow-only');
                if (pluginsWorkflowOnly && pluginsWorkflowOnly.checked) {
                    var wfInfoPlugins = await getWorkflowInfo();
                    if (wfInfoPlugins && wfInfoPlugins.classTypes.length > 0) {
                        try {
                            var matchResp = await fetch('/api/modal/plugins/match', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({class_types: wfInfoPlugins.classTypes}),
                            });
                            if (matchResp.ok) {
                                var matchData = await matchResp.json();
                                var matches = matchData.matches || [];
                                var matchSet = {};
                                for (var mi = 0; mi < matches.length; mi++) matchSet[matches[mi]] = true;
                                var pItems = listEl.querySelectorAll('.modal-plugin-item');
                                var pVisible = 0;
                                for (var pi = 0; pi < pItems.length; pi++) {
                                    var pCb = pItems[pi].querySelector('input[type="checkbox"]');
                                    if (pCb && matchSet[pCb.dataset.pluginName]) {
                                        pVisible++;
                                    } else {
                                        pItems[pi].style.display = 'none';
                                    }
                                }
                                if (pVisible === 0) {
                                    listEl.style.display = 'none';
                                    emptyEl.style.display = 'block';
                                    emptyEl.textContent = 'Aucun node du workflow trouvé localement.';
                                    saveBtn.disabled = true;
                                    return;
                                }
                                showNotification('📋 ' + pVisible + ' node(s) du workflow filtré(s)', 'info');
                            }
                        } catch (e) {
                            showNotification('⚠️ Filtrage workflow échoué: ' + e.message, 'error');
                        }
                    } else if (!wfInfoPlugins) {
                        showNotification('⚠️ Impossible de lire le workflow', 'error');
                    }
                }

                listEl.style.display = 'block';
                saveBtn.disabled = false;

            } catch (e) {
                loadingEl.style.display = 'none';
                btn.disabled = false;
                btn.textContent = '🔄 Détecter mes nodes';
                showNotification('❌ Erreur détection nodes : ' + e.message, 'error');
            }
        };

        document.getElementById('cfg-save-plugins').onclick = async function () {
            var saveBtn = document.getElementById('cfg-save-plugins');
            var listEl = document.getElementById('modal-plugins-list');
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Sauvegarde...';

            try {
                var checkboxes = listEl.querySelectorAll('input[type="checkbox"]:not(:disabled)');
                var customNodesExt = [];
                var customNodesLocal = [];

                for (var i = 0; i < checkboxes.length; i++) {
                    var cb = checkboxes[i];
                    if (cb.checked && cb.dataset.pluginUrl) {
                        var existing = null;
                        if (savedPlugins && savedPlugins.custom_nodes_ext) {
                            for (var j = 0; j < savedPlugins.custom_nodes_ext.length; j++) {
                                if (savedPlugins.custom_nodes_ext[j].url === cb.dataset.pluginUrl) {
                                    existing = savedPlugins.custom_nodes_ext[j];
                                    break;
                                }
                            }
                        }
                        if (existing) {
                            customNodesExt.push(existing);
                        } else {
                            customNodesExt.push({
                                url: cb.dataset.pluginUrl,
                            });
                        }
                    } else if (cb.checked && cb.dataset.pluginIsLocal === 'true') {
                        customNodesLocal.push(cb.dataset.pluginName);
                    }
                }

                var customNodes = (savedPlugins && savedPlugins.custom_nodes) || [];

                var resp = await fetch('/api/modal/plugins', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        custom_nodes: customNodes,
                        custom_nodes_ext: customNodesExt,
                        custom_nodes_local: customNodesLocal,
                    }),
                });

                if (!resp.ok) throw new Error('HTTP ' + resp.status);

                savedPlugins = {
                    custom_nodes: customNodes,
                    custom_nodes_ext: customNodesExt,
                    custom_nodes_local: customNodesLocal,
                };

                saveBtn.textContent = '✅ Sauvegardé';
                showNotification(
                    '✅ ' + (customNodesExt.length + customNodesLocal.length) + ' node(s) sauvegardé(s) (' + customNodesLocal.length + ' local). Redeploy nécessaire.',
                    'success'
                );
                setTimeout(function () {
                    saveBtn.disabled = false;
                    saveBtn.textContent = '💾 Enregistrer la sélection';
                }, 2000);

            } catch (e) {
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 Enregistrer la sélection';
                showNotification('❌ Erreur sauvegarde : ' + e.message, 'error');
            }
        };

        // ─── Models: detect & save ───
        var detectedModels = [];
        var savedModelsSelection = null;

        document.getElementById('cfg-detect-models').onclick = async function () {
            var btn = document.getElementById('cfg-detect-models');
            var listEl = document.getElementById('modal-models-list');
            var loadingEl = document.getElementById('modal-models-loading');
            var emptyEl = document.getElementById('modal-models-empty');
            var saveBtn = document.getElementById('cfg-save-models');

            btn.disabled = true;
            btn.textContent = '⏳ Scan...';
            listEl.style.display = 'none';
            emptyEl.style.display = 'none';
            loadingEl.style.display = 'block';

            try {
                // Load saved selection from config
                if (savedModelsSelection === null) {
                    try {
                        var savedResp = await fetch('/api/modal/models/select');
                        if (savedResp.ok) {
                            savedModelsSelection = await savedResp.json();
                        } else {
                            savedModelsSelection = { models_to_sync: [] };
                        }
                    } catch (e) {
                        savedModelsSelection = { models_to_sync: [] };
                    }
                }

                // Detect local models
                var resp = await fetch('/api/modal/models/detect');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                var data = await resp.json();
                detectedModels = data.models || [];

                loadingEl.style.display = 'none';
                btn.disabled = false;
                btn.textContent = '🔄 Détecter mes modèles';

                if (detectedModels.length === 0) {
                    emptyEl.style.display = 'block';
                    saveBtn.disabled = true;
                    return;
                }

                // Build set of already-saved model keys
                var savedKeys = {};
                if (savedModelsSelection && savedModelsSelection.models_to_sync) {
                    for (var s = 0; s < savedModelsSelection.models_to_sync.length; s++) {
                        var m = savedModelsSelection.models_to_sync[s];
                        savedKeys[m.filename + '|' + m.model_dir] = true;
                    }
                }

                // Render list
                listEl.innerHTML = '';
                for (var i = 0; i < detectedModels.length; i++) {
                    (function (model) {
                        var key = model.filename + '|' + model.model_dir;
                        var item = document.createElement('label');
                        item.className = 'modal-model-item';

                        var checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.dataset.modelFilename = model.filename;
                        checkbox.dataset.modelDir = model.model_dir;
                        checkbox.checked = !!savedKeys[key];

                        var content = document.createElement('div');
                        content.className = 'modal-model-item-content';

                        var nameEl = document.createElement('div');
                        nameEl.className = 'modal-model-item-name';
                        nameEl.textContent = model.filename;

                        var infoEl = document.createElement('div');
                        infoEl.className = 'modal-model-item-info';
                        infoEl.textContent = '📁 ' + model.model_dir + '  ·  ' + model.size_mb + ' MB';

                        content.appendChild(nameEl);
                        content.appendChild(infoEl);

                        item.appendChild(checkbox);
                        item.appendChild(content);
                        listEl.appendChild(item);
                    })(detectedModels[i]);
                }

                var toggleBtn = document.getElementById('cfg-toggle-models');
                toggleBtn.style.display = 'inline-block';
                toggleBtn.textContent = 'Tout sélectionner';
                var allChecked = false;
                toggleBtn.onclick = function () {
                    allChecked = !allChecked;
                    var cbs = listEl.querySelectorAll('input[type="checkbox"]');
                    for (var t = 0; t < cbs.length; t++) cbs[t].checked = allChecked;
                    toggleBtn.textContent = allChecked ? 'Tout désélectionner' : 'Tout sélectionner';
                };

                // Filter by workflow if enabled
                var workflowOnly = document.getElementById('cfg-models-workflow-only');
                if (workflowOnly && workflowOnly.checked) {
                    var wfInfo = await getWorkflowInfo();
                    if (wfInfo && wfInfo.modelFiles.length > 0) {
                        var wfFiles = wfInfo.modelFiles.map(function(f) { return f.toLowerCase(); });
                        var filtered = [];
                        var items = listEl.querySelectorAll('.modal-model-item');
                        for (var fi = 0; fi < items.length; fi++) {
                            var cb = items[fi].querySelector('input[type="checkbox"]');
                            if (cb && wfFiles.indexOf(cb.dataset.modelFilename.toLowerCase()) !== -1) {
                                filtered.push(items[fi]);
                            } else {
                                items[fi].style.display = 'none';
                            }
                        }
                        // Update count
                        var visibleCount = filtered.length;
                        var emptyEl2 = document.getElementById('modal-models-empty');
                        if (visibleCount === 0) {
                            listEl.style.display = 'none';
                            emptyEl2.style.display = 'block';
                            emptyEl2.textContent = 'Aucun modèle du workflow trouvé localement.';
                            saveBtn.disabled = true;
                            return;
                        }
                        showNotification('📋 ' + visibleCount + ' modèle(s) du workflow filtré(s) sur ' + detectedModels.length + ' total', 'info');
                    } else if (!wfInfo) {
                        showNotification('⚠️ Impossible de lire le workflow', 'error');
                    }
                }

                listEl.style.display = 'block';
                saveBtn.disabled = false;

            } catch (e) {
                loadingEl.style.display = 'none';
                btn.disabled = false;
                btn.textContent = '🔄 Détecter mes modèles';
                showNotification('❌ Erreur détection modèles : ' + e.message, 'error');
            }
        };

        document.getElementById('cfg-save-models').onclick = async function () {
            var saveBtn = document.getElementById('cfg-save-models');
            var listEl = document.getElementById('modal-models-list');
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Sauvegarde...';

            try {
                var checkboxes = listEl.querySelectorAll('input[type="checkbox"]');
                var modelsToSync = [];

                for (var i = 0; i < checkboxes.length; i++) {
                    var cb = checkboxes[i];
                    if (cb.checked) {
                        modelsToSync.push({
                            filename: cb.dataset.modelFilename,
                            model_dir: cb.dataset.modelDir,
                        });
                    }
                }

                var resp = await fetch('/api/modal/models/select', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        models_to_sync: modelsToSync,
                    }),
                });

                if (!resp.ok) throw new Error('HTTP ' + resp.status);

                savedModelsSelection = { models_to_sync: modelsToSync };

                var totalMB = 0;
                for (var j = 0; j < detectedModels.length; j++) {
                    for (var k = 0; k < modelsToSync.length; k++) {
                        if (detectedModels[j].filename === modelsToSync[k].filename &&
                            detectedModels[j].model_dir === modelsToSync[k].model_dir) {
                            totalMB += detectedModels[j].size_mb;
                        }
                    }
                }

                saveBtn.textContent = '✅ Sauvegardé';
                showNotification(
                    '✅ ' + modelsToSync.length + ' modèle(s) sélectionné(s) — ' + Math.round(totalMB) + ' MB. Cliquez sur « 📥 Sync vers Modal ».',
                    'success'
                );
                setTimeout(function () {
                    saveBtn.disabled = false;
                    saveBtn.textContent = '💾 Enregistrer la sélection';
                }, 2000);

            } catch (e) {
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 Enregistrer la sélection';
                showNotification('❌ Erreur sauvegarde : ' + e.message, 'error');
            }
        };

        // ── Remplissage en arrière-plan ───────────────────────────────────
        // Charger la config puis peupler les champs + badges
        var config = { api_url: CONFIG.API_URL, api_key_set: !!CONFIG.API_KEY };
        try {
            var resp = await fetch('/api/modal/config');
            if (resp.ok) config = await resp.json();
        } catch (e) { /* mode dégradé : utiliser les constantes */ }
        modalConfig = config;

        // Champs de connexion API Modal
        var apiUrlEl = document.getElementById('cfg-api-url');
        if (apiUrlEl) apiUrlEl.value = config.api_url || '';
        var apiKeyEl = document.getElementById('cfg-api-key');
        if (apiKeyEl) {
            // api_key n'est jamais renvoyée en clair : on ne pré-remplit pas le
            // champ et on signale uniquement qu'une clé existe déjà.
            window._apiKeySet = !!config.api_key_set;
            if (window._apiKeySet) {
                apiKeyEl.placeholder = '●●●●● (clé enregistrée — laisser vide pour conserver)';
            }
            updateSecretHint();
        }

        // Hôtes autorisés (reverse proxy)
        var allowedHostsEl = document.getElementById('cfg-allowed-hosts');
        if (allowedHostsEl && Array.isArray(config.allowed_hosts)) {
            allowedHostsEl.value = config.allowed_hosts.join(', ');
        }

        // Résumé de la barre « Connexion » (replié par défaut)
        updatePrereqSummary();

        // ── Paquets pip supplémentaires (dépendances optionnelles) ──────
        // Champ libre « a, b, c ». Le serveur écarte les entrées dangereuses
        // (caractères shell interdits) et renvoie la liste retenue.
        var extraPipEl = document.getElementById('cfg-extra-pip');
        var saveExtraPipBtn = document.getElementById('cfg-save-extra-pip');
        if (extraPipEl && Array.isArray(config.extra_pip_packages)) {
            extraPipEl.value = config.extra_pip_packages.join(', ');
        }
        if (extraPipEl && saveExtraPipBtn) {
            saveExtraPipBtn.onclick = async function () {
                var packages = (extraPipEl.value || '')
                    .split(',')
                    .map(function (p) { return p.trim(); })
                    .filter(function (p) { return p.length > 0; });
                saveExtraPipBtn.disabled = true;
                try {
                    var resp = await fetch('/api/modal/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ extra_pip_packages: packages }),
                    });
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    var payload = await resp.json();
                    var saved = (payload && payload.config &&
                        Array.isArray(payload.config.extra_pip_packages))
                        ? payload.config.extra_pip_packages
                        : packages;
                    // Refléter la liste réellement retenue par le serveur.
                    extraPipEl.value = saved.join(', ');
                    if (modalConfig) modalConfig.extra_pip_packages = saved;
                    var dropped = packages.length - saved.length;
                    if (dropped > 0) {
                        showNotification(
                            '⚠️ ' + dropped + ' entrée(s) ignorée(s) (caractères interdits). ' +
                            saved.length + ' paquet(s) enregistré(s) — un déploiement (🚀 Déployer) est nécessaire pour les installer.',
                            'info'
                        );
                    } else {
                        showNotification(
                            '✅ ' + saved.length + ' paquet(s) pip enregistré(s) — un déploiement (🚀 Déployer) est nécessaire pour les installer.',
                            'success'
                        );
                    }
                    saveExtraPipBtn.textContent = '✅';
                    setTimeout(function () { saveExtraPipBtn.textContent = '💾'; }, 2000);
                } catch (e) {
                    showNotification('❌ Erreur sauvegarde paquets pip : ' + e.message, 'error');
                } finally {
                    saveExtraPipBtn.disabled = false;
                }
            };
        }

        // Badges de date (sync / deploy / user sync) : rendus par une fonction
        // dédiée afin de pouvoir être rafraîchis après une opération sans
        // reconstruire la modale (cf. refreshOperationState).
        renderOperationBadges(config);

        // Badge de l'étape 2 — custom nodes réellement présents sur le volume
        // comfy-custom-nodes (manifeste écrit par sync.py).
        await fetchInstalledNodes();

        // ─── User Settings : statut du dossier user/ local ───
        var userStatusEl = document.getElementById('status-user-settings');
        if (userStatusEl) {
            fetch('/api/modal/user-settings/status')
                .then(function (r) { return r.json(); })
                .then(function (status) {
                    if (status.exists) {
                        userStatusEl.textContent = '✅ ' + status.file_count + ' fichiers (' + status.size_mb + ' MB)';
                        userStatusEl.className = 'val ok';
                    } else {
                        userStatusEl.textContent = '❌ Non trouvé';
                        userStatusEl.className = 'val warn';
                    }
                })
                .catch(function () {
                    userStatusEl.textContent = '❌ Erreur';
                    userStatusEl.className = 'val warn';
                });
        }

        // ─── Statuts Modal + pastilles header + bandeau auth ──────────
        refreshStatus();

        document.getElementById('cfg-sync-user').onclick = function() {
            runOperation('sync-user');
        };
        document.getElementById('cfg-sync-custom-nodes').onclick = function() {
            runOperation('sync-custom-nodes');
        };
        var restartWorkerBtn = document.getElementById('cfg-run-restart-worker');
        if (restartWorkerBtn) {
            restartWorkerBtn.onclick = function () { restartWorker(); };
        }
    }

    // ─── Redémarrage du worker (sync PUIS redémarrage) ────────────────────

    /**
     * Demande confirmation avant d'interrompre un rendu en cours.
     *
     * Fail-closed : sans UI de confirmation disponible, on ne redémarre PAS
     * (un redémarrage pendant un rendu le fait échouer côté gateway).
     *
     * @returns {Promise<boolean>}
     */
    function confirmRestartDuringRender() {
        var title = t('comfych.run.restartConfirmTitle', 'Redémarrer le worker ?');
        var message = t(
            'comfych.run.restartConfirmBody',
            'Un rendu est en cours : redémarrer le worker va l\'interrompre et le faire échouer. Continuer ?'
        );
        var confirmText = t('comfych.run.restartConfirmAction', 'Redémarrer');
        var cancelText = t('dialog.cancel', 'Annuler');
        var A = window.AIH;
        if (A && typeof A.confirm === 'function') {
            return Promise.resolve(
                A.confirm(title, message, { danger: true, confirmText: confirmText, cancelText: cancelText })
            ).then(function (ok) { return !!ok; }, function () { return false; });
        }
        if (typeof window.aihShowConfirm === 'function') {
            return Promise.resolve(window.aihShowConfirm(title, message)).then(
                function (ok) { return !!ok; },
                function () { return false; }
            );
        }
        return Promise.resolve(false);
    }

    /**
     * « Redémarrer le worker » : SYNC puis redémarrage, dans cet ordre.
     *
     * L'ordre est imposé par le worker lui-même
     * (workers/base_worker.py, ``_sync_user_settings_from_volume`` : copie du
     * volume vers ``ComfyUI/user`` au DÉMARRAGE du container, jamais pendant).
     * Redémarrer sans syncer rechargerait donc l'ancien volume — d'où un seul
     * bouton qui enchaîne les deux, et un serveur qui refuse l'inversion.
     */
    async function restartWorker() {
        var renderActive = RenderQueue.counts().processing > 0;
        var body = { render_in_progress: renderActive, confirm: false };
        if (renderActive) {
            var confirmed = await confirmRestartDuringRender();
            if (!confirmed) return;
            body.confirm = true;
        }
        runOperation('restart-worker', { body: body });
    }

    // ─── Initialisation via l'API d'extension ComfyUI ───────────────────────

    /**
     * Attend que l'application ComfyUI soit disponible, puis enregistre
     * une extension ComfyUI pour injecter le dropdown dans la barre d'outils.
     *
     * Technique identique à FR.IA :
     * 1. Poke window.app / window.comfyAPI?.app?.app
     * 2. Appelle app.registerExtension()
     * 3. Dans setup(), trouve le bouton Settings via app.menu.settingsGroup.element
     * 4. Insère le dropdown avant ce bouton
     */
    (function waitForComfyApp() {
        var app = window.app || (
            window.comfyAPI &&
            window.comfyAPI.app &&
            window.comfyAPI.app.app
        );
        if (!app) {
            setTimeout(waitForComfyApp, 100);
            return;
        }

        console.log('Modal Gateway: app ComfyUI trouvée, enregistrement de l\'extension.');

        app.registerExtension({
            name: EXTENSION_NAME,
            async setup() {
                console.log('Modal Gateway: setup() de l\'extension appelé.');

                // Injecter les styles CSS dès que possible
                injectModalStyles();

                // Sélecteur GPU : HÉBERGÉ par le pack AI-Helper (sous-menu
                // « AIH ▾ → Outils & Dev → ComfyCH ») quand son pont est
                // présent — la barre d'outils de ComfyUI reste alors allégée.
                // Le repli sur la barre d'outils ne concerne que l'usage
                // autonome de ComfyCH (pack absent).
                if (window.AIHComfyCHHost) {
                    console.log('Modal Gateway: sélecteur hébergé par le menu AIH (aucune injection dans la barre d\'outils).');
                } else {
                    setTimeout(function () {
                        injectDropdownInToolbar(app);
                    }, 50);
                }
            },
        });
    })();

    /**
     * Point d'entrée principal (initialisation legacy).
     * Injecte les styles et tente d'intercepter queuePrompt.
     * L'injection du dropdown est maintenant gérée par l'extension ci-dessus.
     */
    function init() {
        console.log('Modal Gateway: extension chargée.');
        console.log('Modal Gateway: document.readyState =', document.readyState);

        // ── Injecter les styles CSS (dropdown + modale) — sécurisé, already() checké ──
        injectModalStyles();

        // ── Intercepter Queue Prompt ──
        // On réessaie périodiquement jusqu'à ce que window.api soit disponible.
        var attempts = 0;
        var retryTimer = setInterval(function () {
            attempts++;
            var success = interceptQueuePrompt();
            if (success) {
                clearInterval(retryTimer);
                console.log('Modal Gateway: interception de queuePrompt activée.');
            } else if (attempts >= CONFIG.MAX_RETRIES) {
                clearInterval(retryTimer);
                console.warn(
                    'Modal Gateway: impossible d\'intercepter queuePrompt après ' +
                    attempts + ' tentatives. Rechargez la page.'
                );
                showNotification(
                    '⚠️  Modal Gateway n\'a pas pu s\'activer. Rechargez la page.',
                    'error'
                );
            }
        }, CONFIG.RETRY_INTERVAL);

        // ── Diagnostic (console) ──
        console.debug('Modal Gateway: API via findApi():', findApi() ? '✅ trouvée' : '❌ absente');
        var diagnosticSources = [
            'window.api',
            'window.comfyAPI.api',
            'window.comfyAPI.app.app.api',
            'window.comfyapp.api'
        ];
        for (var d = 0; d < diagnosticSources.length; d++) {
            var parts = diagnosticSources[d].split('.');
            var val = window;
            for (var p = 0; p < parts.length; p++) {
                if (val && typeof val === 'object' && parts[p] in val) {
                    val = val[parts[p]];
                } else {
                    val = undefined;
                    break;
                }
            }
            console.debug('Modal Gateway: ' + diagnosticSources[d] + ' queuePrompt ?',
                val && typeof val.queuePrompt === 'function' ? '✅' : '❌');
        }
    }

    // ─── Démarrage selon l'état du document ─────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // DOMContentLoaded déjà passé — on lance directement
        init();
    }
})();
