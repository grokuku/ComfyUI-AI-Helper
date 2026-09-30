
    function copyEnhanceOutput() {
      var el = document.getElementById('enhance-output');
      el.select();
      document.execCommand('copy');
      showModal('Copie', 'Prompt copie !', 'success');
    }

    function toggleEnhanceView() {
      var ta = document.getElementById('enhance-output');
      var div = document.getElementById('enhance-output-rendered');
      var btn = document.getElementById('btn-toggle-view');
      if (div.classList.contains('hidden')) {
        // Passer en mode rendu (texte brut, sauts de ligne)
        var raw = ta.value;
        div.innerHTML = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        ta.classList.add('hidden');
        div.classList.remove('hidden');
        btn.textContent = 'Brut';
      } else {
        div.classList.add('hidden');
        ta.classList.remove('hidden');
        btn.textContent = 'Rendu';
      }
    }

    // Charger presets et styles au demarrage
    // Charger les types depuis les templates disponibles
    async function loadTemplateTypes() {
      var sel = document.getElementById('enhance-type');
      if (!sel) return;
      var currentVal = sel.value;
      sel.innerHTML = '<option value="">-- Chargement --</option>';
      try {
        var res = await fetch(API + '/prompts/templates');
        var list = await safeJson(res);
        if (!Array.isArray(list) || list.length === 0) {
          sel.innerHTML = '<option value="">-- Template --</option>';
          return;
        }
        sel.innerHTML = '<option value="">-- Template --</option>';
        var found = false;
        list.forEach(function(t) {
          var opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name || ('Template ' + t.id);
          sel.appendChild(opt);
          if (String(t.id) === currentVal) found = true;
        });
        if (found) sel.value = currentVal;
      } catch {
        sel.innerHTML = '<option value="">-- Template --</option>';
      }
    }

    async function loadEnhancerConfig() {
      await loadPresets();
      await loadStyles();
      await loadTemplateTypes();
      // Restaurer les autres preferences sauvegardees
      if (currentUser && currentUser.settings) {
        var s = currentUser.settings;
        if (s.enhanceType) document.getElementById('enhance-type').value = s.enhanceType;
        if (s.enhanceInput) document.getElementById('enhance-input').value = s.enhanceInput;
        if (s.enhanceEP) document.getElementById('enhance-ep').checked = s.enhanceEP;
        if (s.enhanceRandom) {
          document.getElementById('enhance-random').checked = s.enhanceRandom;
          document.getElementById('enhance-random-count').disabled = !s.enhanceRandom;
          if (s.enhanceRandomCount) document.getElementById('enhance-random-count').value = s.enhanceRandomCount;
        }
        if (s.enhanceOutput) {
          document.getElementById('enhance-output').value = s.enhanceOutput;
          document.getElementById('btn-copy-enhance').classList.remove('hidden');
          document.getElementById('btn-toggle-view').classList.remove('hidden');
        }
      }
      // Sauvegarde auto au changement
      var elPreset = document.getElementById('enhance-preset');
      var elType = document.getElementById('enhance-type');
      var elStyle = document.getElementById('enhance-style');
      var elInput = document.getElementById('enhance-input');
      elPreset.onchange = saveEnhancerSettings;
      elType.onchange = saveEnhancerSettings;
      elType.addEventListener('mousedown', loadTemplateTypes);
      elStyle.onchange = saveEnhancerSettings;
      elInput.oninput = function() { clearTimeout(elInput._saveTimer); elInput._saveTimer = setTimeout(saveEnhancerSettings, 800); };
      // Toggle random count
      var randCb = document.getElementById('enhance-random');
      var randNum = document.getElementById('enhance-random-count');
      if (randCb && randNum) {
        randCb.onchange = function() { randNum.disabled = !this.checked; };
        randNum.disabled = !randCb.checked;
      }
    }

    var _saveSettingsBusy = false;
    async function saveEnhancerSettings() {
      if (_saveSettingsBusy || !currentUser) return;
      _saveSettingsBusy = true;
      var settings = currentUser.settings || {};
      settings.enhancePresetId = document.getElementById('enhance-preset').value || null;
      settings.enhanceStyleId = document.getElementById('enhance-style').value || null;
      settings.enhanceType = document.getElementById('enhance-type').value;
      settings.enhanceEP = document.getElementById('enhance-ep').checked;
      settings.enhanceRandom = document.getElementById('enhance-random').checked;
      settings.enhanceRandomCount = document.getElementById('enhance-random-count').value;
      settings.enhanceInput = document.getElementById('enhance-input').value;
      settings.enhanceOutput = document.getElementById('enhance-output').value || null;
      try {
        var r = await fetch(API + '/settings', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(settings)
        });
        if (r.ok) currentUser.settings = settings;
      } catch (e) {}
      _saveSettingsBusy = false;
    }


    // === Modale generique ===
    var modalCallback = null;
    var modalType = '';

    function showModal(title, msg, type) {
      document.getElementById('modal-generic-title').textContent = title;
      document.getElementById('modal-generic-body').textContent = msg;
      document.getElementById('modal-generic-input-area').classList.add('hidden');
      document.getElementById('modal-generic-cancel').classList.add('hidden');
      document.getElementById('modal-generic-ok').textContent = 'OK';
      var header = document.getElementById('modal-generic-header');
      if (type === 'error') {
        var okBtn = document.getElementById('modal-generic-ok');
        okBtn.className = 'px-3 py-1.5 text-sm font-medium bg-rose-600 text-white rounded-md hover:bg-rose-500';
        header.className = header.className.replace('bg-slate-50','bg-rose-50').replace('dark:bg-slate-800/80','dark:bg-rose-900/20');
      } else if (type === 'success') {
        var okBtn = document.getElementById('modal-generic-ok');
        okBtn.className = 'px-3 py-1.5 text-sm font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-500';
        header.className = header.className.replace('bg-slate-50','bg-emerald-50').replace('dark:bg-slate-800/80','dark:bg-emerald-900/20');
      } else {
        var okBtn = document.getElementById('modal-generic-ok');
        okBtn.className = 'px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-500';
      }
      modalType = type || '';
      modalCallback = null;
      document.getElementById('modal-generic').classList.remove('hidden');
      document.getElementById('modal-generic').classList.add('flex');
    }

    function showConfirm(title, msg, cb) {
      document.getElementById('modal-generic-title').textContent = title;
      document.getElementById('modal-generic-body').textContent = msg;
      document.getElementById('modal-generic-input-area').classList.add('hidden');
      document.getElementById('modal-generic-cancel').classList.remove('hidden');
      document.getElementById('modal-generic-ok').textContent = 'Oui';
      document.getElementById('modal-generic-ok').className = 'px-3 py-1.5 text-sm font-medium bg-rose-600 text-white rounded-md hover:bg-rose-500';
      modalType = 'confirm';
      modalCallback = cb;
      document.getElementById('modal-generic').classList.remove('hidden');
      document.getElementById('modal-generic').classList.add('flex');
    }

    function showPrompt(title, msg, placeholder, cb) {
      document.getElementById('modal-generic-title').textContent = title;
      document.getElementById('modal-generic-body').textContent = msg;
      document.getElementById('modal-generic-input-area').classList.remove('hidden');
      document.getElementById('modal-generic-input').value = '';
      document.getElementById('modal-generic-input').placeholder = placeholder || '';
      document.getElementById('modal-generic-input').focus();
      document.getElementById('modal-generic-cancel').classList.remove('hidden');
      document.getElementById('modal-generic-ok').textContent = 'OK';
      document.getElementById('modal-generic-ok').className = 'px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-500';
      modalType = 'prompt';
      modalCallback = cb;
      document.getElementById('modal-generic').classList.remove('hidden');
      document.getElementById('modal-generic').classList.add('flex');
    }

    function closeModal() {
      document.getElementById('modal-generic').classList.add('hidden');
      document.getElementById('modal-generic').classList.remove('flex');
      var header = document.getElementById('modal-generic-header');
      header.className = 'border-b border-slate-200 bg-slate-50 px-5 py-3 flex items-center justify-between cursor-grab dark:border-slate-700 dark:bg-slate-800/80 select-none';
      modalCallback = null;
    }

    function modalOK() {
      var result = null;
      if (modalType === 'confirm') result = true;
      if (modalType === 'prompt') result = document.getElementById('modal-generic-input').value.trim() || null;
      var cb = modalCallback;
      closeModal();
      if (cb && result !== null) cb(result);
    }

    // Drag pour la modale generique
    document.addEventListener('DOMContentLoaded', function() {
      makeModalDraggable('modal-generic-header', 'modal-generic');
    });

    // === Panneau Admin ===
    function toggleAdmin() {
      if (LOCAL_MODE) { showModal('Admin', 'Indisponible en mode local', 'error'); return; }
      var panel = document.getElementById('admin-panel');
      var isOpen = !panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (!isOpen) {
        switchAdminTab('global');
      }
    }

    function switchAdminTab(tab) {
      ['global', 'embedding', 'users', 'backup'].forEach(function(t) {
        var content = document.getElementById('admin-tab-' + t);
        var btn = document.getElementById('admin-tab-btn-' + t);
        if (content) content.classList.add('hidden');
        if (btn) {
          btn.classList.remove('border-indigo-500', 'text-indigo-600', 'dark:text-indigo-400');
          btn.classList.add('border-transparent', 'text-slate-500', 'dark:text-slate-400');
        }
      });
      var content = document.getElementById('admin-tab-' + tab);
      var btn = document.getElementById('admin-tab-btn-' + tab);
      if (content) content.classList.remove('hidden');
      if (btn) {
        btn.classList.add('border-indigo-500', 'text-indigo-600', 'dark:text-indigo-400');
        btn.classList.remove('border-transparent', 'text-slate-500', 'dark:text-slate-400');
      }
      if (tab === 'users') { loadAdminUsers(); loadWhitelist(); }
      if (tab === 'embedding') loadOllamaConfig();
      if (tab === 'global') loadSftpConfig();
      if (tab === 'backup') loadBackupConfig();
    }

    function toggleMembers() {
      if (LOCAL_MODE) { showModal('Membres', 'Indisponible en mode local', 'error'); return; }
      var panel = document.getElementById('members-panel');
      panel.classList.remove('hidden');
      loadMembersList();
    }

    function closeMembers() {
      document.getElementById('members-panel').classList.add('hidden');
    }

    function closeMemberDetail() {
      document.getElementById('modal-member-detail').classList.add('hidden');
      document.getElementById('modal-member-detail').classList.remove('flex');
    }

    async function openMemberDetail(userId) {
      var modal = document.getElementById('modal-member-detail');
      var body = document.getElementById('member-detail-body');
      var nameEl = document.getElementById('member-detail-name');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      makeModalDraggable('member-detail-header', 'member-detail-modal');
      body.innerHTML = '<p class="text-xs text-slate-400">Chargement...</p>';
      try {
        var res = await fetch(API + '/members/' + userId);
        if (!res.ok) { body.innerHTML = '<p class="text-xs text-red-400">Erreur</p>'; return; }
        var m = await safeJson(res);
        nameEl.textContent = m.display_name || m.username || 'Membre';
        var avatarHtml = m.avatar_url
          ? '<img src="' + m.avatar_url + '" class="w-20 h-20 rounded-full mx-auto border-2 border-slate-300 dark:border-slate-600">'
          : '<div class="w-20 h-20 rounded-full bg-slate-500 mx-auto flex items-center justify-center text-2xl text-white">' + escapeHtml((m.display_name || m.username || '?')[0]) + '</div>';
        var statsHtml = '<div class="grid grid-cols-2 gap-2 text-center text-xs">'
          + '<div class="bg-slate-50 dark:bg-slate-700/50 rounded p-2"><span class="block text-lg font-bold text-indigo-600 dark:text-indigo-400">' + (m.filter_count || 0) + '</span><span class="text-slate-500">filtres</span></div>'
          + '<div class="bg-slate-50 dark:bg-slate-700/50 rounded p-2"><span class="block text-lg font-bold text-indigo-600 dark:text-indigo-400">' + (m.prompt_count || 0) + '</span><span class="text-slate-500">prompts</span></div>'
          + '</div>';
        var favHtml = '';
        if (m.favorite_type || m.favorite_style) {
          favHtml = '<div class="text-xs space-y-1"><p class="text-slate-500 font-semibold mb-1">Preferes</p>';
          if (m.favorite_type) favHtml += '<p><span class="text-slate-400">Type :</span> <span class="text-slate-700 dark:text-slate-300">' + m.favorite_type.toUpperCase() + '</span></p>';
          if (m.favorite_style) favHtml += '<p><span class="text-slate-400">Style :</span> <span class="text-slate-700 dark:text-slate-300">' + escapeHtml(m.favorite_style) + '</span></p>';
          favHtml += '</div>';
        }
        var promptsHtml = '<p class="text-xs text-slate-500 font-semibold">Derniers prompts</p>';
        if (m.recent_prompts && m.recent_prompts.length > 0) {
          promptsHtml += '<div class="space-y-1 max-h-80 overflow-y-auto">';
          m.recent_prompts.forEach(function(p) {
            var text = p.output_text || '';
            var date = p.created_at ? new Date(p.created_at).toLocaleDateString('fr-FR') : '';
            promptsHtml += '<div class="text-xs p-2 rounded bg-slate-50 dark:bg-slate-700/30 border border-slate-200 dark:border-slate-700">'
              + '<span class="text-indigo-500 font-medium">' + escapeHtml(p.template_name || '') + '</span>'
              + ' <span class="text-slate-400">' + date + '</span><br>'
              + '<span class="text-slate-600 dark:text-slate-400" style="word-break:break-word;">' + escapeHtml(text) + '</span></div>';
          });
          promptsHtml += '</div>';
        } else {
          promptsHtml += '<p class="text-xs text-slate-400 italic">Aucun prompt genere</p>';
        }
        body.innerHTML = '<div class="space-y-3">'
          + '<div class="text-center">' + avatarHtml + '</div>'
          + '<div class="text-center text-xs text-slate-500">' + (m.role === 'admin' ? 'Admin' : m.role === 'kw_editor' ? 'KW Editor' : 'Membre') + '</div>'
          + statsHtml
          + (favHtml ? '<hr class="border-slate-200 dark:border-slate-700">' + favHtml : '')
          + '<hr class="border-slate-200 dark:border-slate-700">'
          + promptsHtml
          + '</div>';
      } catch (err) {
        body.innerHTML = '<p class="text-xs text-red-400">Erreur : ' + err.message + '</p>';
      }
    }

    // === Clés API (multi-clés nommées) ===
    //
    // Modèle actuel : PLUSIEURS clés nommées par utilisateur (une par machine
    // ComfyUI), AUCUNE expiration, révocation INDIVIDUELLE. La clé en clair
    // n'est affichée qu'UNE SEULE FOIS, juste après sa création.

    function toggleSettings() {
      toggleMergedSettings();
    }

    function closeSettings() {
      closeMergedSettings();
    }

    // ── i18n FR/EN (parité stricte) ─────────────────────────────────────────
    // La page est en FR par défaut (<html lang="fr">). On résout la langue via
    // `localStorage.aih_locale` (convention du pack), sinon navigator.language.
    var API_TOKENS_I18N = {
      fr: {
        title: 'Clés API',
        desc: 'Utilisez ces clés pour connecter ComfyUI & autres outils à votre compte. Nomme chaque clé pour retrouver la machine associée.',
        namePlaceholder: 'Nom de la clé (ex. ComfyUI salon)',
        create: 'Nouvelle clé',
        copy: 'Copier',
        rename: 'Renommer',
        revoke: 'Révoquer',
        active: 'Active',
        revoked: 'Révoquée',
        empty: 'Aucune clé API.',
        loading: 'Chargement...',
        createdAt: 'Créée le {date}',
        lastUsed: 'Dernière utilisation : {date}',
        neverUsed: 'Jamais utilisée',
        revealWarning: '⚠️ Copie-la maintenant : elle ne sera plus affichée.',
        copied: 'Copié !',
        copyImpossible: 'Copie impossible.',
        copyMasked: 'Aucune clé copiable : crée une nouvelle clé pour en afficher une.',
        copyTitleMasked: 'Aucune clé à copier — crée une nouvelle clé',
        copyTitleReady: 'Copier la clé API',
        nameRequired: 'Le nom de la clé est obligatoire.',
        createOk: 'Clé créée ! Copie-la maintenant.',
        renamePrompt: 'Nouveau nom de la clé :',
        renameOk: 'Clé renommée.',
        revokeConfirm: 'Révoquer « {name} » ? Cette clé cessera immédiatement de fonctionner. Les autres clés restent valides.',
        revokeOk: 'Clé révoquée.',
        actionError: 'Erreur : {msg}',
        unavailableLocal: 'Indisponible en mode local',
        apiError: 'Erreur {status}'
      },
      en: {
        title: 'API keys',
        desc: 'Use these keys to connect ComfyUI & other tools to your account. Name each key to remember which machine it belongs to.',
        namePlaceholder: 'Key name (e.g. ComfyUI studio)',
        create: 'New key',
        copy: 'Copy',
        rename: 'Rename',
        revoke: 'Revoke',
        active: 'Active',
        revoked: 'Revoked',
        empty: 'No API key.',
        loading: 'Loading...',
        createdAt: 'Created on {date}',
        lastUsed: 'Last used: {date}',
        neverUsed: 'Never used',
        revealWarning: '⚠️ Copy it now: it will never be shown again.',
        copied: 'Copied!',
        copyImpossible: 'Copy failed.',
        copyMasked: 'No copyable key: create a new key to reveal one.',
        copyTitleMasked: 'No key to copy — create a new key',
        copyTitleReady: 'Copy the API key',
        nameRequired: 'The key name is required.',
        createOk: 'Key created! Copy it now.',
        renamePrompt: 'New key name:',
        renameOk: 'Key renamed.',
        revokeConfirm: 'Revoke "{name}"? This key will stop working immediately. The other keys remain valid.',
        revokeOk: 'Key revoked.',
        actionError: 'Error: {msg}',
        unavailableLocal: 'Unavailable in local mode',
        apiError: 'Error {status}'
      }
    };

    function apiTokensLang() {
      var stored = null;
      try { stored = localStorage.getItem('aih_locale'); } catch (e) {}
      if (stored === 'en' || stored === 'fr') return stored;
      var nav = '';
      try { nav = String(navigator.language || '').toLowerCase(); } catch (e) {}
      return nav.indexOf('en') === 0 ? 'en' : 'fr';
    }

    function tApi(key, params) {
      var dict = API_TOKENS_I18N[apiTokensLang()] || API_TOKENS_I18N.fr;
      var s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : (API_TOKENS_I18N.fr[key] || key);
      if (params) {
        Object.keys(params).forEach(function(k) {
          s = s.split('{' + k + '}').join(String(params[k]));
        });
      }
      return s;
    }

    async function apiTokensJson(res) {
      try { return await res.json(); } catch (e) { return {}; }
    }

    // ── Garde-fou anti-masque (logique DÉJÀ CORRIGÉE, conservée) ─────────────
    // Bug réel : le masquage mettait un TEXTE (« Clé masquée — clique sur
    // « Régénérer »… ») dans la VALEUR du champ ; « Copier » recopiait ce texte,
    // collé ensuite comme clé API → 401 incompréhensible. Règle : le masque vit
    // dans `placeholder` (jamais copiable comme valeur), le champ reste vide
    // hors révélation, et aucune valeur masquée/vide ne peut être copiée.
    var API_KEY_MASK_RE = /(masqu|r[ée]g[ée]n[ée]r|\bhidden\b|\bplaceholder\b|\b(chargement|loading)\b|\b(indisponible|unavailable)\b|\b(pas de token|no token)\b|\b(erreur|error)\b)/i;

    function apiKeyLooksMasked(value) {
      var s = String(value == null ? '' : value).trim();
      return s.length > 0 && API_KEY_MASK_RE.test(s);
    }

    function apiKeyIsCopyable(value) {
      var s = String(value == null ? '' : value).trim();
      return s.length > 0 && !apiKeyLooksMasked(s);
    }

    // Seul un token RÉEL (renvoyé par POST /auth/tokens) est copiable : évite
    // que l'état interne mente si la valeur du champ a été modifiée autrement.
    var apiKeyCopyable = false;

    function updateApiKeyCopyButton() {
      var btn = document.getElementById('settings-copy-key');
      if (!btn) return;
      btn.disabled = !apiKeyCopyable;
      btn.title = apiKeyCopyable ? tApi('copyTitleReady') : tApi('copyTitleMasked');
      btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
    }

    function _applyTokensStatusClass(el, kind) {
      el.className = 'text-xs mt-2 ' + (kind === 'success' ? 'text-emerald-500' : kind === 'error' ? 'text-rose-500' : 'text-amber-500');
    }

    function showApiKeyStatus(kind, message, autoHideMs) {
      var el = document.getElementById('settings-key-status');
      if (!el) return;
      _applyTokensStatusClass(el, kind);
      el.textContent = message;
      el.classList.remove('hidden');
      if (autoHideMs) {
        setTimeout(function() { el.classList.add('hidden'); }, autoHideMs);
      }
    }

    function showApiTokensStatus(kind, message, autoHideMs) {
      var el = document.getElementById('api-tokens-status');
      if (!el) return;
      _applyTokensStatusClass(el, kind);
      el.textContent = message;
      el.classList.remove('hidden');
      if (autoHideMs) {
        setTimeout(function() { el.classList.add('hidden'); }, autoHideMs);
      }
    }

    function applyApiTokensI18n() {
      var t = document.getElementById('api-tokens-title'); if (t) t.textContent = tApi('title');
      var d = document.getElementById('api-tokens-desc'); if (d) d.textContent = tApi('desc');
      var n = document.getElementById('api-token-new-name'); if (n) n.placeholder = tApi('namePlaceholder');
      var c = document.getElementById('api-token-create-btn'); if (c) c.textContent = tApi('create');
      var w = document.getElementById('api-token-reveal-warning'); if (w) w.textContent = tApi('revealWarning');
      var cp = document.getElementById('settings-copy-key'); if (cp) cp.textContent = tApi('copy');
      var empty = document.getElementById('api-tokens-empty'); if (empty) empty.textContent = tApi('empty');
    }

    function hideApiKeyReveal() {
      var box = document.getElementById('api-token-reveal');
      if (box) box.classList.add('hidden');
      var input = document.getElementById('settings-api-key');
      if (input) { input.value = ''; input.placeholder = ''; }
      apiKeyCopyable = false;
      updateApiKeyCopyButton();
    }

    // Affiche UNE SEULE FOIS la clé en clair renvoyée par la création.
    function showApiKeyReveal(token) {
      var box = document.getElementById('api-token-reveal');
      var input = document.getElementById('settings-api-key');
      if (!box || !input) return;
      input.value = String(token || '');
      input.placeholder = '';
      apiKeyCopyable = apiKeyIsCopyable(token);
      var warn = document.getElementById('api-token-reveal-warning');
      if (warn) warn.textContent = tApi('revealWarning');
      box.classList.remove('hidden');
      updateApiKeyCopyButton();
    }

    function _formatTokenDate(value) {
      if (!value) return '';
      var s = String(value);
      var d = new Date(s.indexOf('T') >= 0 ? s : s.replace(' ', 'T') + 'Z');
      if (isNaN(d.getTime())) d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.toLocaleString(apiTokensLang() === 'en' ? 'en-US' : 'fr-FR');
    }

    function renderApiTokens(tokens) {
      var list = document.getElementById('api-tokens-list');
      if (!list) return;
      list.innerHTML = '';
      var items = Array.isArray(tokens) ? tokens : [];
      var empty = document.getElementById('api-tokens-empty');
      if (empty) {
        empty.textContent = tApi('empty');
        empty.classList.toggle('hidden', items.length > 0);
      }
      items.forEach(function(tok) { list.appendChild(_renderApiTokenRow(tok)); });
    }

    function _renderApiTokenRow(tok) {
      var row = document.createElement('div');
      row.className = 'flex items-start justify-between gap-2 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2';
      row.setAttribute('data-token-id', String(tok.id));

      var info = document.createElement('div');
      info.className = 'min-w-0 text-xs';

      var nameLine = document.createElement('div');
      nameLine.className = 'flex items-center gap-2';
      var nameEl = document.createElement('span');
      nameEl.className = 'api-token-name font-medium text-slate-800 dark:text-slate-200';
      nameEl.textContent = String(tok.name == null ? '' : tok.name);
      nameLine.appendChild(nameEl);
      if (tok.revoked) {
        var badge = document.createElement('span');
        badge.className = 'api-token-state text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300';
        badge.textContent = tApi('revoked');
        nameLine.appendChild(badge);
      }
      info.appendChild(nameLine);

      var meta = document.createElement('div');
      meta.className = 'mt-0.5 text-slate-400 dark:text-slate-500';
      var prefix = document.createElement('span');
      prefix.className = 'api-token-prefix font-mono';
      prefix.textContent = tok.prefix ? (tok.prefix + '…') : '—';
      meta.appendChild(prefix);
      var created = document.createElement('span');
      created.className = 'api-token-created ml-2';
      created.textContent = tApi('createdAt', { date: _formatTokenDate(tok.created_at) });
      meta.appendChild(created);
      info.appendChild(meta);

      var usage = document.createElement('div');
      usage.className = 'api-token-usage mt-0.5 text-slate-400 dark:text-slate-500';
      if (tok.last_used_at) {
        var line = tApi('lastUsed', { date: _formatTokenDate(tok.last_used_at) });
        if (tok.last_used_ip) line += ' · ' + String(tok.last_used_ip);
        if (tok.last_used_user_agent) line += ' · ' + String(tok.last_used_user_agent).slice(0, 60);
        usage.textContent = line;
      } else {
        usage.textContent = tApi('neverUsed');
      }
      info.appendChild(usage);

      row.appendChild(info);

      var actions = document.createElement('div');
      actions.className = 'flex shrink-0 gap-1';
      if (!tok.revoked) {
        var renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'api-token-rename px-2 py-1 text-[11px] border border-slate-300 dark:border-slate-600 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700';
        renameBtn.textContent = tApi('rename');
        renameBtn.onclick = function() { renameApiToken(tok.id); };
        actions.appendChild(renameBtn);

        var revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'api-token-revoke px-2 py-1 text-[11px] border border-rose-300 dark:border-rose-700 rounded text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/30';
        revokeBtn.textContent = tApi('revoke');
        revokeBtn.onclick = function() { revokeApiToken(tok.id, tok.name); };
        actions.appendChild(revokeBtn);
      }
      row.appendChild(actions);
      return row;
    }

    // Charge la LISTE des clés nommées (jamais les clés elles-mêmes).
    async function loadApiKey() {
      if (LOCAL_MODE) return;
      var nameEl = document.getElementById('settings-username');
      if (nameEl && currentUser) nameEl.textContent = currentUser.display_name || currentUser.username;
      applyApiTokensI18n();
      hideApiKeyReveal();
      showApiTokensStatus('warn', tApi('loading'));
      try {
        var res = await fetch(API + '/auth/tokens');
        if (!res.ok) throw new Error(tApi('apiError', { status: res.status }));
        var data = await apiTokensJson(res);
        renderApiTokens((data && data.tokens) || []);
        var st = document.getElementById('api-tokens-status');
        if (st) { st.classList.add('hidden'); st.textContent = ''; }
      } catch (err) {
        renderApiTokens([]);
        showApiTokensStatus('error', tApi('actionError', { msg: err.message }));
      }
    }

    // Crée une nouvelle clé nommée → la clé est affichée UNE SEULE FOIS.
    async function createApiToken() {
      if (LOCAL_MODE) { showModal('API Key', tApi('unavailableLocal'), 'error'); return; }
      var nameInput = document.getElementById('api-token-new-name');
      var name = nameInput ? String(nameInput.value || '').trim() : '';
      if (!name) { showApiTokensStatus('error', tApi('nameRequired')); return; }
      try {
        var res = await fetch(API + '/auth/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        var data = await apiTokensJson(res);
        if (!res.ok) throw new Error((data && data.error) || tApi('apiError', { status: res.status }));
        if (nameInput) nameInput.value = '';
        await loadApiKey();
        showApiKeyReveal((data && data.token) || '');
        showApiTokensStatus('success', tApi('createOk'));
      } catch (err) {
        showApiTokensStatus('error', tApi('actionError', { msg: err.message }));
      }
    }

    async function renameApiToken(id) {
      if (LOCAL_MODE) { showModal('API Key', tApi('unavailableLocal'), 'error'); return; }
      var newName = prompt(tApi('renamePrompt'));
      if (newName == null) return;
      newName = String(newName).trim();
      if (!newName) { showApiTokensStatus('error', tApi('nameRequired')); return; }
      try {
        var res = await fetch(API + '/auth/tokens/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        var data = await apiTokensJson(res);
        if (!res.ok) throw new Error((data && data.error) || tApi('apiError', { status: res.status }));
        showApiTokensStatus('success', tApi('renameOk'), 2000);
        loadApiKey();
      } catch (err) {
        showApiTokensStatus('error', tApi('actionError', { msg: err.message }));
      }
    }

    async function revokeApiToken(id, name) {
      if (LOCAL_MODE) { showModal('API Key', tApi('unavailableLocal'), 'error'); return; }
      if (!confirm(tApi('revokeConfirm', { name: name || '' }))) return;
      try {
        var res = await fetch(API + '/auth/tokens/' + id, { method: 'DELETE' });
        var data = await apiTokensJson(res);
        if (!res.ok) throw new Error((data && data.error) || tApi('apiError', { status: res.status }));
        showApiTokensStatus('success', tApi('revokeOk'), 2000);
        loadApiKey();
      } catch (err) {
        showApiTokensStatus('error', tApi('actionError', { msg: err.message }));
      }
    }

    function copyApiKey() {
      var input = document.getElementById('settings-api-key');
      var value = String(input.value || '');
      // Garde-fou : ne copie JAMAIS un masque / placeholder / champ vide.
      if (!apiKeyCopyable || !apiKeyIsCopyable(value)) {
        showApiKeyStatus('warn', tApi('copyMasked'));
        return;
      }
      input.select();
      input.setSelectionRange(0, 99999);
      var write = (navigator.clipboard && typeof navigator.clipboard.writeText === 'function')
        ? navigator.clipboard.writeText(value)
        : Promise.reject(new Error('clipboard indisponible'));
      write.then(function() {
        showApiKeyStatus('success', tApi('copied'), 2000);
      }).catch(function() {
        // Repli : copie de la sélection — la sélection porte la VALEUR RÉELLE
        // (le garde-fou ci-dessus a déjà refusé masque/vide).
        if (document.execCommand('copy')) {
          showApiKeyStatus('success', tApi('copied'), 2000);
        } else {
          showApiKeyStatus('error', tApi('copyImpossible'));
        }
      });
    }

    async function loadMembersList() {
      var container = document.getElementById('members-list');
      container.innerHTML = '<p class="text-sm text-slate-400">Chargement...</p>';
      try {
        var res = await fetch(API + '/members');
        if (!res.ok) {
          container.innerHTML = '<p class="text-sm text-rose-500">Erreur ' + res.status + '</p>';
          return;
        }
        var users = await res.json();
        container.innerHTML = users.map(function(u) {
          var avatar = u.avatar
            ? '<img src="https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png?size=32" class="w-6 h-6 rounded-full inline-block">'
            : '<span class="w-6 h-6 rounded-full bg-slate-500 inline-flex items-center justify-center text-xs text-white">' + escapeHtml((u.display_name || u.username)[0]) + '</span>';
          var badge = u.role === 'admin'
            ? '<span class="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">admin</span>'
            : u.role === 'kw_editor'
              ? '<span class="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300">kw_editor</span>'
              : '<span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400">user</span>';
          return '<div class="flex items-center gap-2.5 p-2 rounded bg-slate-50 dark:bg-slate-700/30 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition" onclick="openMemberDetail(\'' + u.id + '\')">'
            + avatar + ' '
            + '<span class="flex-1 text-sm text-slate-700 dark:text-slate-300">' + escapeHtml(u.display_name || u.username) + '</span>'
            + ' ' + badge
            + '</div>';
        }).join('');
      } catch (err) {
        container.innerHTML = '<p class="text-sm text-rose-500">Erreur reseau</p>';
      }
    }

    async function loadAdminUsers() {
      var container = document.getElementById('admin-users-list');
      container.innerHTML = '<p class="text-sm text-slate-400">Chargement...</p>';
      try {
        var res = await fetch(API + '/admin/users');
        if (!res.ok) {
          var err = await res.json().catch(function(){ return {}; });
          container.innerHTML = '<p class="text-sm text-rose-500">Erreur ' + res.status + ' : ' + (err.error || 'Acces refuse') + '</p>';
          return;
        }
        var users = await res.json();
        container.innerHTML = users.map(function(u) {
          var isYou = currentUser && u.id === currentUser.id;
          var badge = u.role === 'admin'
            ? '<span class="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">admin</span>'
            : u.role === 'kw_editor'
              ? '<span class="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300">kw_editor</span>'
              : '<span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400">user</span>';
          var avatar = u.avatar
            ? '<img src="https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png?size=32" class="w-6 h-6 rounded-full inline-block">'
            : '<span class="w-6 h-6 rounded-full bg-slate-500 inline-flex items-center justify-center text-xs text-white">' + escapeHtml((u.display_name || u.username)[0]) + '</span>';
          var actions = '';
          if (u.role === 'user') {
            actions += '<button class="text-xs text-amber-500 hover:text-amber-400 transition" onclick="changeRole(\'' + u.id + '\',\'kw_editor\')">+ KW Editor</button> ';
            actions += '<button class="text-xs text-indigo-500 hover:text-indigo-400 transition" onclick="changeRole(\'' + u.id + '\',\'admin\')">+ Admin</button>';
          } else if (u.role === 'kw_editor') {
            actions += '<button class="text-xs text-indigo-500 hover:text-indigo-400 transition" onclick="changeRole(\'' + u.id + '\',\'admin\')">+ Admin</button> ';
            if (!isYou) actions += '<button class="text-xs text-amber-500 hover:text-amber-400 transition" onclick="changeRole(\'' + u.id + '\',\'user\')">- KW Editor</button>';
          } else if (!isYou) {
            actions += '<button class="text-xs text-amber-500 hover:text-amber-400 transition" onclick="changeRole(\'' + u.id + '\',\'kw_editor\')">Rétrograder (KW Editor)</button> ';
            actions += '<button class="text-xs text-rose-500 hover:text-rose-400 transition" onclick="changeRole(\'' + u.id + '\',\'user\')">Rétrograder (user)</button>';
          }
          if (!isYou) {
            actions += ' <button class="text-xs text-rose-500 hover:text-rose-400 transition" onclick="deleteUser(\'' + u.id + '\')">Supprimer</button>';
          }
          var youTag = isYou ? ' <span class="text-xs text-slate-400">(toi)</span>' : '';
          return '<div class="flex items-center gap-2.5 p-2 rounded bg-slate-50 dark:bg-slate-700/30">'
            + avatar + ' '
            + '<span class="flex-1 text-sm text-slate-700 dark:text-slate-300">' + escapeHtml(u.display_name || u.username) + youTag + '</span>'
            + ' ' + badge
            + (actions ? ' <span class="text-xs text-slate-400">|</span> ' + actions : '')
            + '</div>';
        }).join('');
      } catch (err) {
        container.innerHTML = '<p class="text-sm text-rose-500">Erreur reseau : ' + (err.message || 'impossible') + '</p>';
      }
    }

    async function loadWhitelist() {
      try {
        var res = await fetch(API + '/admin/whitelist');
        if (!res.ok) return;
        var data = await res.json();
        var list = document.getElementById('admin-whitelist-list');
        list.innerHTML = '';
        if (data.length === 0) {
          list.innerHTML = '<p class="text-xs text-slate-400">Aucun UID dans la whitelist</p>';
          return;
        }
        data.forEach(function(item) {
          var div = document.createElement('div');
          div.className = 'flex items-center justify-between px-2 py-1.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700';
          var span = document.createElement('span');
          span.className = 'text-sm font-mono text-slate-600 dark:text-slate-300';
          span.textContent = item.discord_uid;
          div.appendChild(span);
          var delBtn = document.createElement('button');
          delBtn.textContent = 'Supprimer';
          delBtn.className = 'text-xs text-rose-500 hover:text-rose-400 transition';
          delBtn.onclick = function() { deleteWhitelist(item.discord_uid); };
          div.appendChild(delBtn);
          list.appendChild(div);
        });
      } catch (err) {
        console.error('loadWhitelist:', err);
      }
    }

    async function addWhitelist() {
      var uid = document.getElementById('admin-whitelist-uid').value.trim();
      if (!uid) return;
      try {
        var res = await fetch(API + '/admin/whitelist', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({discord_uid: uid})
        });
        if (res.ok) {
          document.getElementById('admin-whitelist-uid').value = '';
          loadWhitelist();
        } else {
          var data = await res.json().catch(function(){ return {}; });
          showModal('Erreur', (data.error || 'Échec de l\'ajout'), 'error');
        }
      } catch (err) {
        showModal('Erreur', 'Erreur réseau : ' + (err.message || 'impossible'), 'error');
      }
    }

    async function deleteWhitelist(uid) {
      showConfirm('Whitelist', 'Retirer cet UID de la whitelist ?', async function(ok) {
        if (!ok) return;
        try {
          var res = await fetch(API + '/admin/whitelist/' + encodeURIComponent(uid), {method: 'DELETE'});
          if (res.ok) loadWhitelist();
        } catch (err) {
          showModal('Erreur', err.message || 'Action impossible', 'error');
        }
      });
    }

    async function changeRole(userId, role) {
      try {
        var res = await fetch(API + '/admin/users/' + encodeURIComponent(userId) + '/role', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({role: role})
        });
        if (res.ok) loadAdminUsers();
      } catch (err) {
        showModal('Erreur', err.message || 'Action impossible', 'error');
      }
    }

    async function deleteUser(userId) {
      showConfirm('Suppression', 'Supprimer cet utilisateur et tous ses mots-cles ?', async function(ok) {
        if (!ok) return;
        try {
          var res = await fetch(API + '/admin/users/' + encodeURIComponent(userId), {method: 'DELETE'});
          if (res.ok) loadAdminUsers();
        } catch (err) {
          showModal('Erreur', err.message || 'Une erreur est survenue', 'error');
        }
      });
    }

    async function loadOllamaConfig() {
      try {
        var res = await fetch(API + '/admin/settings/ollama');
        if (!res.ok) return;
        var data = await res.json();
        document.getElementById('admin-ollama-url').value = data.url || 'http://localhost:11434';
        document.getElementById('admin-ollama-model').value = data.model || 'nomic-embed-text';
        var st = document.getElementById('admin-ollama-status');
        st.textContent = 'OK';
        st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
      } catch (err) {
        var st = document.getElementById('admin-ollama-status');
        st.textContent = 'Erreur';
        st.className = 'text-xs px-2 py-1 rounded bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400';
      }
    }

    async function saveOllamaConfig() {
      var url = document.getElementById('admin-ollama-url').value.trim();
      var model = document.getElementById('admin-ollama-model').value.trim();
      if (!url || !model) { showModal('Config', 'URL et modele requis', 'error'); return; }
      try {
        var res = await fetch(API + '/admin/settings/ollama', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({url: url, model: model})
        });
        if (res.ok) {
          var st = document.getElementById('admin-ollama-status');
          st.textContent = 'Sauvegarde OK';
          st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
        } else {
          var err = await res.json();
          showModal('Erreur', err.error || '', 'error');
        }
      } catch (err) {
        showModal('Erreur', err.message || '', 'error');
      }
    }

    async function adminClearDb() {
      showConfirm('Vider la BDD', 'Vider la base de donnees ? Cette action est irreversible.', async function(ok) {
        if (!ok) return;
        try {
          var res = await fetch(API + '/admin/db/clear', {method: 'POST'});
          if (res.ok) {
            toggleAdmin();
            await checkAuth();
            await checkData();
          }
        } catch (err) {
          showModal('Erreur', err.message || 'Action impossible', 'error');
        }
      });
    }

    // === SFTP Config ===

    async function loadSftpConfig() {
      try {
        var res = await fetch(API + '/admin/settings/sftp');
        if (!res.ok) return;
        var data = await res.json();
        document.getElementById('admin-sftp-host').value = data.host || '';
        document.getElementById('admin-sftp-port').value = data.port || 22;
        document.getElementById('admin-sftp-user').value = data.user || '';
        document.getElementById('admin-sftp-password').value = '';  // jamais afficher le mot de passe
        document.getElementById('admin-sftp-basepath').value = data.base_path || '/aih';
        var st = document.getElementById('admin-sftp-status');
        if (data.host) {
          st.textContent = 'Configuré';
          st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
        } else {
          st.textContent = 'Non configuré (stockage local)';
          st.className = 'text-xs px-2 py-1 rounded bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400';
        }
      } catch (err) {
        console.error('loadSftpConfig:', err);
      }
    }

    async function saveSftpConfig() {
      var host = document.getElementById('admin-sftp-host').value.trim();
      var port = parseInt(document.getElementById('admin-sftp-port').value) || 22;
      var user = document.getElementById('admin-sftp-user').value.trim();
      var password = document.getElementById('admin-sftp-password').value;  // pas de trim (peut avoir des espaces)
      var base_path = document.getElementById('admin-sftp-basepath').value.trim() || '/aih';

      var body = { host: host, port: port, user: user, base_path: base_path };
      // Ne pas envoyer le mot de passe s'il est vide (garder l'ancien)
      if (password) body.password = password;

      try {
        var res = await fetch(API + '/admin/settings/sftp', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });
        if (res.ok) {
          var st = document.getElementById('admin-sftp-status');
          st.textContent = 'Sauvegardé !';
          st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
          document.getElementById('admin-sftp-password').value = '';
          setTimeout(function() { loadSftpConfig(); }, 1500);
        } else {
          var err = await res.json().catch(function(){ return {}; });
          showModal('Erreur', err.error || 'Sauvegarde impossible', 'error');
        }
      } catch (err) {
        showModal('Erreur', err.message, 'error');
      }
    }

    async function testSftpConfig() {
      var st = document.getElementById('admin-sftp-status');
      st.textContent = 'Test en cours...';
      st.className = 'text-xs px-2 py-1 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400';
      try {
        var res = await fetch(API + '/admin/settings/sftp/test', { method: 'POST' });
        var data = await res.json();
        if (res.ok && data.ok) {
          st.textContent = '✅ Connexion réussie (' + data.backend + ')';
          st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
        } else {
          st.textContent = '❌ ' + (data.error || 'Échec de connexion');
          st.className = 'text-xs px-2 py-1 rounded bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400';
        }
      } catch (err) {
        st.textContent = '❌ ' + err.message;
        st.className = 'text-xs px-2 py-1 rounded bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400';
      }
    }

    // === Backup Config ===

    async function loadBackupConfig() {
      try {
        var res = await fetch(API + '/admin/settings/backup');
        if (!res.ok) return;
        var data = await res.json();
        document.getElementById('admin-backup-enabled').checked = !!data.enabled;
        document.getElementById('admin-backup-interval').value = String(data.interval_hours || 24);
        document.getElementById('admin-backup-retain').value = data.max_backups || 7;
        if (data.last_backup) {
          var hist = document.getElementById('admin-backup-history');
          hist.innerHTML = '<p>Dernier backup : <strong>' + esc(data.last_backup) + '</strong></p>';
        }
      } catch (err) {
        console.error('loadBackupConfig:', err);
      }
    }

    async function saveBackupConfig() {
      var enabled = document.getElementById('admin-backup-enabled').checked;
      var interval = parseInt(document.getElementById('admin-backup-interval').value) || 24;
      var retain = parseInt(document.getElementById('admin-backup-retain').value) || 7;

      try {
        var res = await fetch(API + '/admin/settings/backup', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ enabled: enabled, interval_hours: interval, max_backups: retain })
        });
        if (res.ok) {
          var st = document.getElementById('admin-backup-status');
          st.textContent = 'Sauvegardé !';
          st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
          setTimeout(function() { st.textContent = '...'; st.className = 'text-xs px-2 py-1 rounded bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'; }, 2000);
        }
      } catch (err) {
        showModal('Erreur', err.message, 'error');
      }
    }

    async function triggerBackupNow() {
      var st = document.getElementById('admin-backup-status');
      st.textContent = 'Backup en cours...';
      st.className = 'text-xs px-2 py-1 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400';
      try {
        var res = await fetch(API + '/admin/settings/backup/now', { method: 'POST' });
        var data = await res.json();
        if (res.ok && data.ok) {
          st.textContent = '✅ Backup terminé';
          st.className = 'text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';
          loadBackupConfig();
        } else {
          st.textContent = '❌ ' + (data.error || 'Échec');
          st.className = 'text-xs px-2 py-1 rounded bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400';
        }
      } catch (err) {
        st.textContent = '❌ ' + err.message;
        st.className = 'text-xs px-2 py-1 rounded bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400';
      }
    }

    // === Layout panneaux redimensionnables ===
    function makeColResizable(dividerId, leftId, rightId, minPct) {
      var divider = document.getElementById(dividerId);
      var left = document.getElementById(leftId);
      if (!divider || !left) return;
      minPct = minPct || 20;

      divider.addEventListener('mousedown', function(e) {
        e.preventDefault();
        var startX = e.clientX;
        var startW = left.offsetWidth;
        var parentW = left.parentElement.offsetWidth;

        function onMove(ev) {
          var dx = ev.clientX - startX;
          var pct = Math.max(minPct, Math.min(80, (startW + dx) / parentW * 100));
          left.style.width = pct + '%';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    function initResizablePanels() {
      var dividerV = document.getElementById('divider-v');
      var dividerH = document.getElementById('divider-h');
      var panelLeft = document.getElementById('panel-left');
      var panelRightTop = document.getElementById('panel-right-top');

      if (dividerV) {
        dividerV.addEventListener('mousedown', function(e) {
          e.preventDefault();
          var startX = e.clientX;
          var startW = panelLeft.offsetWidth;
          var parentW = document.getElementById('panels-container').offsetWidth;

          function onMove(ev) {
            var dx = ev.clientX - startX;
            var pct = Math.max(15, Math.min(85, (startW + dx) / parentW * 100));
            panelLeft.style.width = pct + '%';
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            saveLayout();
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }

      if (dividerH) {
        dividerH.addEventListener('mousedown', function(e) {
          e.preventDefault();
          var startY = e.clientY;
          var startH = panelRightTop.offsetHeight;
          var parentH = panelRightTop.parentElement.offsetHeight;

          function onMove(ev) {
            var dy = ev.clientY - startY;
            var pct = Math.max(10, Math.min(90, (startH + dy) / parentH * 100));
            panelRightTop.style.height = pct + '%';
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            saveLayout();
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }
    }

    function saveLayout() {
      if (!currentUser) return;
      var leftPct = Math.round(parseFloat(document.getElementById('panel-left').style.width) || 50);
      var topPct = Math.round(parseFloat(document.getElementById('panel-right-top').style.height) || 50);
      var settings = (currentUser.settings || {});
      settings.layout = { left_width: leftPct, right_top_height: topPct };
      // Save to server (fire and forget)
      fetch(API + '/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(settings)
      }).catch(function(){});
    }

    function loadLayout() {
      if (!currentUser || !currentUser.settings) return;
      var layout = currentUser.settings.layout;
      if (!layout) return;
      var panelLeft = document.getElementById('panel-left');
      var panelRightTop = document.getElementById('panel-right-top');
      if (layout.left_width && panelLeft) panelLeft.style.width = layout.left_width + '%';
      if (layout.right_top_height && panelRightTop) panelRightTop.style.height = layout.right_top_height + '%';
    }

    // === Enregistrement des hauteurs de textarea ===
    function initStyleTextareaResize() {
      var taText = document.getElementById('t-style-form-text');
      var taNeg = document.getElementById('t-style-form-neg');
      if (!taText && !taNeg) return;

      // Restaurer les hauteurs sauvegardees
      if (currentUser && currentUser.settings && currentUser.settings.style_textarea) {
        var saved = currentUser.settings.style_textarea;
        if (saved.text_h && taText) taText.style.height = saved.text_h + 'px';
        if (saved.neg_h && taNeg) taNeg.style.height = saved.neg_h + 'px';
      }

      var _saveTimer = null;
      function saveHeights() {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function() {
          if (!currentUser) return;
          var settings = currentUser.settings || {};
          settings.style_textarea = {
            text_h: taText ? taText.offsetHeight : null,
            neg_h: taNeg ? taNeg.offsetHeight : null
          };
          fetch(API + '/settings', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(settings)
          }).catch(function(){});
        }, 500);
      }

      [taText, taNeg].forEach(function(ta) {
        if (!ta) return;
        // Ecouter mouseup (lache du handle de resize natif)
        ta.addEventListener('mouseup', saveHeights);
        // ResizeObserver comme fallback
        if (window.ResizeObserver) {
          new ResizeObserver(function() { saveHeights(); }).observe(ta);
        }
      });
    }

    // === Colonnes redimensionnables ===
    var colResizeActive = null;

    function initColResize() {
      var headers = document.querySelectorAll('#table-header-row th');
      // Initialiser les largeurs si pas encore fait (en px explicite)
      if (!headers[0] || headers[0].style.width) return;
      var widths = [200, 400, 180, 100]; // valeurs par defaut
      for (var i = 0; i < headers.length; i++) {
        var w = headers[i].offsetWidth || widths[i] || 150;
        headers[i].style.width = w + 'px';
      }

      headers.forEach(function(th, idx) {
        if (idx === headers.length - 1) return;
        if (th.querySelector('.col-resize-handle')) return;
        var handle = document.createElement('div');
        handle.className = 'col-resize-handle';
        handle.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();  // empecher le drag des modales
          var next = headers[idx + 1];
          colResizeActive = {
            th: th, nextTh: next,
            startX: e.clientX,
            w: th.offsetWidth,
            wNext: next.offsetWidth,
            idx: idx
          };
          document.body.classList.add('col-resizing');
        }, true);  // capturer en phase de capture
        th.appendChild(handle);
      });
    }

    document.addEventListener('mousemove', function(e) {
      if (!colResizeActive) return;
      var dx = e.clientX - colResizeActive.startX;
      var w = Math.max(50, colResizeActive.w + dx);
      var wNext = Math.max(50, colResizeActive.wNext - dx);
      var i = colResizeActive.idx;
      colResizeActive.th.style.width = w + 'px';
      colResizeActive.nextTh.style.width = wNext + 'px';
      // Appliquer aux cellules
      var rows = document.querySelectorAll('#table-body tr');
      for (var r = 0; r < rows.length; r++) {
        var tds = rows[r].children;
        if (tds[i]) tds[i].style.width = w + 'px';
        if (tds[i+1]) tds[i+1].style.width = wNext + 'px';
      }
    });

    document.addEventListener('mouseup', function() {
      if (colResizeActive) {
        colResizeActive = null;
        document.body.classList.remove('col-resizing');
        saveColWidths();
      }
    });

    function saveColWidths() {
      if (!currentUser) return;
      var headers = document.querySelectorAll('#table-header-row th');
      var widths = {};
      headers.forEach(function(th, idx) {
        var txt = th.textContent.trim().toLowerCase().replace(/[^a-z]/g, '') || 'col' + idx;
        widths[txt] = th.offsetWidth;
      });
      var settings = (currentUser.settings || {});
      settings.columns = widths;
      fetch(API + '/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(settings)
      }).catch(function(){});
    }

    function loadColWidths() {
      if (!currentUser || !currentUser.settings || !currentUser.settings.columns) return;
      var headers = document.querySelectorAll('#table-header-row th');
      var cols = currentUser.settings.columns;
      headers.forEach(function(th, idx) {
        var txt = th.textContent.trim().toLowerCase().replace(/[^a-z]/g, '') || 'col' + idx;
        var w = cols[txt];
        if (w && w > 50) {
          th.style.width = w + 'px';
          var rows = document.querySelectorAll('#table-body tr');
          for (var r = 0; r < rows.length; r++) {
            var td = rows[r].children[idx];
            if (td) td.style.width = w + 'px';
          }
        }
      });
    }

    // Drag unifie pour toutes les modales
    function makeModalDraggable(headerId, modalId) {
      var drag = { active: false, startX: 0, startY: 0, origX: 0, origY: 0 };
      var header = document.getElementById(headerId);
      var modal = document.getElementById(modalId);
      if (!header || !modal) return;
      header.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
        drag.active = true;
        var rect = modal.getBoundingClientRect();
        drag.startX = e.clientX;
        drag.startY = e.clientY;
        drag.origX = rect.left;
        drag.origY = rect.top;
        modal.style.position = 'fixed';
        modal.style.left = rect.left + 'px';
        modal.style.top = rect.top + 'px';
        modal.style.transform = 'none';
        modal.style.margin = '0';
        header.style.cursor = 'grabbing';
        e.preventDefault();
      });
      document.addEventListener('mousemove', function(e) {
        if (!drag.active) return;
        var dx = e.clientX - drag.startX;
        var dy = e.clientY - drag.startY;
        modal.style.left = (drag.origX + dx) + 'px';
        modal.style.top = (drag.origY + dy) + 'px';
      });
      document.addEventListener('mouseup', function() {
        if (drag.active) {
          drag.active = false;
          header.style.cursor = 'grab';
        }
      });
    }

    function makeModalResizable(modalId, opts) {
      opts = opts || {};
      var minW = opts.minW || 400;
      var minH = opts.minH || 300;
      var maxW = opts.maxW || window.innerWidth * 0.9;
      var maxH = opts.maxH || window.innerHeight * 0.9;
      var modal = document.getElementById(modalId);
      if (!modal) return;
      var directions = ['n','s','e','w','ne','nw','se','sw'];
      var handles = {};
      directions.forEach(function(dir) {
        var h = document.createElement('div');
        h.className = 'modal-resize-handle ' + dir;
        modal.appendChild(h);
        handles[dir] = h;
      });
      var resize = { active: false, dir: '', startX: 0, startY: 0, startW: 0, startH: 0, startL: 0, startT: 0 };
      function getStyle(name) { return parseFloat(modal.style[name]) || 0; }
      directions.forEach(function(dir) {
        handles[dir].addEventListener('mousedown', function(e) {
          e.preventDefault();
          var rect = modal.getBoundingClientRect();
          resize.active = true;
          resize.dir = dir;
          resize.startX = e.clientX;
          resize.startY = e.clientY;
          resize.startW = rect.width;
          resize.startH = rect.height;
          resize.startL = rect.left;
          resize.startT = rect.top;
          modal.classList.add('modal-resizing');
        });
      });
      document.addEventListener('mousemove', function(e) {
        if (!resize.active) return;
        var dir = resize.dir;
        var dx = e.clientX - resize.startX;
        var dy = e.clientY - resize.startY;
        var newW = resize.startW;
        var newH = resize.startH;
        var newL = resize.startL;
        var newT = resize.startT;
        if (dir.indexOf('e') >= 0) newW = Math.min(maxW, Math.max(minW, resize.startW + dx));
        if (dir.indexOf('w') >= 0) {
          newW = Math.min(maxW, Math.max(minW, resize.startW - dx));
          newL = resize.startL + (resize.startW - newW);
        }
        if (dir.indexOf('s') >= 0) newH = Math.min(maxH, Math.max(minH, resize.startH + dy));
        if (dir.indexOf('n') >= 0) {
          newH = Math.min(maxH, Math.max(minH, resize.startH - dy));
          newT = resize.startT + (resize.startH - newH);
        }
        modal.style.width = newW + 'px';
        modal.style.height = newH + 'px';
        modal.style.left = newL + 'px';
        modal.style.top = newT + 'px';
        // Update max-height on modal-body if present
        var body = modal.querySelector('.modal-body');
        if (body) {
          var header = modal.querySelector('[id$="-header"]') || modal.querySelector('[class*="header"]');
          var headerH = header ? header.offsetHeight : 0;
          body.style.maxHeight = (newH - headerH - 2) + 'px';
        }
      });
      document.addEventListener('mouseup', function() {
        if (resize.active) {
          resize.active = false;
          modal.classList.remove('modal-resizing');
        }
      });
    }

    // Initialiser le drag pour toutes les modales + panneaux
    document.addEventListener('DOMContentLoaded', function() {
      makeModalDraggable('admin-modal-header', 'admin-modal');
      makeModalDraggable('import-modal-header', 'import-modal');
      makeModalDraggable('members-modal-header', 'members-modal');
      makeModalResizable('usettings-modal', { minW: 480, minH: 400 });
      initResizablePanels();
      makeColResizable('styles-divider', 'styles-left', 'styles-right', 25);
      makeColResizable('templates-divider', 'templates-left', 'templates-right', 25);
      makeColResizable('kw-divider', 'kw-left', 'kw-right', 25);
      initStyleTextareaResize();
    });
    // === Import / Export ===
    function openImport() {
      if (LOCAL_MODE) { showModal('Import', 'Indisponible en mode local', 'error'); return; }
      var el = document.getElementById('modal-import');
      el.classList.remove('hidden');
      el.classList.add('flex');
      document.getElementById('import-status').classList.add('hidden');
      document.getElementById('import-loading').classList.add('hidden');
    }
    function closeImport() {
      var el = document.getElementById('modal-import');
      el.classList.add('hidden');
      el.classList.remove('flex');
      document.getElementById('import-status').classList.add('hidden');
    }

    function handleFile(e) {
      const file = e.target.files?.[0];
      if (file) sendImport(file);
    }
    function handleDrop(e) {
      e.preventDefault();
      $('drop-zone').classList.remove('border-indigo-400','bg-indigo-50/30');
      const file = e.dataTransfer.files?.[0];
      if (file && file.name.endsWith('.md')) {
        sendImport(file);
      } else {
        showImportStatus(false, 'Déposez un fichier .md uniquement.');
      }
    }

    async function sendImport(file) {
      if (LOCAL_MODE) { showImportStatus(false, 'Indisponible en mode local'); return; }
      $('import-loading').classList.remove('hidden');
      $('import-status').classList.add('hidden');
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch(`${API}/import`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Erreur ${res.status}`);
        showImportStatus(true, data.message || `${data.imported} importes` + (data.updated ? `, ${data.updated} mis a jour` : '') + (data.duplicates_skipped ? `, ${data.duplicates_skipped} ignores` : '') + '.');
        await checkData();
      } catch (err) {
        showImportStatus(false, err.message || 'Erreur lors de l\'import');
      } finally {
        $('import-loading').classList.add('hidden');
      }
    }

    function showImportStatus(ok, message) {
      const el = $('import-status');
      el.classList.remove('hidden');
      el.className = 'mt-4 text-sm rounded-md p-3 border ' + (ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200');
      el.textContent = message;
    }

    async function doExport() {
      if (LOCAL_MODE) { showModal('Export', 'Indisponible en mode local', 'error'); return; }
      try {
        const res = await fetch(`${API}/export`);
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Keywords-Export.md';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        showModal('Erreur', 'Export impossible : ' + err.message, 'error');
      }
    }
  