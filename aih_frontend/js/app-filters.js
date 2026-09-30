
    // === Save Filter ===
    var loadedFilterId = null;

    function openSaveFilter() {
      document.getElementById('modal-save-filter').classList.remove('hidden');
      document.getElementById('modal-save-filter').classList.add('flex');
      document.getElementById('save-filter-name').focus();
      makeModalDraggable('save-modal-header', 'save-filter-modal');
    }
    function closeSaveFilter() {
      document.getElementById('modal-save-filter').classList.add('hidden');
      document.getElementById('modal-save-filter').classList.remove('flex');
    }
    function discardFilter() {
      loadedFilterId = null;
      document.getElementById('filter-loaded-name').classList.add('hidden');
      document.getElementById('btn-filter-save').classList.add('hidden');
      document.getElementById('btn-filter-discard').classList.add('hidden');
    }

    function getFilterConfig() {
      return {
        section: getSectionParam(),
        subsection: getSubsectionParam(),
        search_text: document.getElementById('search-input').value,
        search_neg: document.getElementById('search-neg-input').value,
        semantic_text: document.getElementById('search-semantic-input').value,
        nsfw_filter: getNsfwFilter(),
        min_confidence: parseFloat(document.getElementById('filter-confidence').value) / 100,
        hidden_kw_ids: Object.keys(hiddenKWs).map(Number)
      };
    }

    function applyFilterConfig(config) {
      var c = config || {};
      // Restaurer les sélections multi-select
      selectedSections = new Set((c.section || '').split(',').filter(function(v){ return v.trim() !== ''; }));
      selectedSubsections = new Set((c.subsection || '').split(',').filter(function(v){ return v.trim() !== ''; }));
      document.getElementById('search-input').value = c.search_text || '';
      document.getElementById('search-neg-input').value = c.search_neg || '';
      document.getElementById('search-semantic-input').value = c.semantic_text || '';
      var nsfw = c.nsfw_filter !== undefined ? c.nsfw_filter : '';
      document.querySelectorAll('input[name="nsfw-filter"]').forEach(function(r){ r.checked = r.value === nsfw; });
      document.getElementById('filter-confidence').value = Math.round((c.min_confidence || 0) * 100);
      document.getElementById('filter-confidence-num').value = Math.round((c.min_confidence || 0) * 100);
      // Restaurer les mots masqués (👁️)
      hiddenKWs = {};
      if (c.hidden_kw_ids && Array.isArray(c.hidden_kw_ids)) {
        c.hidden_kw_ids.forEach(function(id){ hiddenKWs[id] = true; });
      }
      // Mettre à jour les boutons et recharger les sous-sections
      updateSectionButton();
      // Charger les sous-sections pour les sections sélectionnées, puis restaurer la sélection
      loadSubsections(getSectionParam()).then(function() {
        // Re-appliquer la sélection de sous-sections maintenant que le dropdown est peuplé
        var subCheckboxes = document.querySelectorAll('#subsection-dropdown input[type="checkbox"]');
        subCheckboxes.forEach(function(cb) { cb.checked = selectedSubsections.has(cb.value); });
        updateSubsectionButton();
      });
      applyFilters(true);
    }

    async function saveCurrentFilter() {
      if (LOCAL_MODE) { showModal('Filtre', 'Sauvegarde indisponible en mode local', 'error'); return; }
      if (!loadedFilterId) return;
      var config = getFilterConfig();
      try {
        var res = await fetch(API + '/filters/' + loadedFilterId, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({config: config})
        });
        if (res.ok) {
          var pv = await fetch(API + '/filters/' + loadedFilterId + '/preview');
          var pd = pv.ok ? await pv.json() : null;
          var preview = pd && pd.keywords && pd.keywords.length > 0 ? ' | Apercu: ' + pd.keywords.slice(0,5).join(', ') : '';
          showModal('Filtre', 'Filtre mis a jour ! ' + (pd ? pd.total : '?') + ' mots-cles dans le cache.' + preview, 'success');
        } else {
          var err = await res.json().catch(function(){ return {}; });
          showModal('Erreur', err.error || '', 'error');
        }
      } catch (err) {
        showModal('Erreur', err.message || 'Une erreur est survenue', 'error');
      }
    }

    async function saveFilter() {
      if (LOCAL_MODE) { showModal('Filtre', 'Sauvegarde indisponible en mode local', 'error'); return; }
      var name = document.getElementById('save-filter-name').value.trim();
      if (!name) { showModal('Filtre', 'Donne un nom au filtre', 'error'); return; }
      var cat = document.getElementById('save-filter-cat').value.trim();
      var nsfw = document.querySelector('input[name="save-filter-nsfw"]:checked');
      var nsfwVal = nsfw ? parseInt(nsfw.value) : 0;
      var isPublic = document.getElementById('save-filter-public').checked ? 1 : 0;
      var config = getFilterConfig();
      try {
        var res = await fetch(API + '/filters', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({name: name, category: cat, nsfw: nsfwVal, is_public: isPublic, config: config})
        });
        if (res.ok) {
          var data = await res.json();
          closeSaveFilter();
          document.getElementById('save-filter-name').value = '';
          document.getElementById('save-filter-cat').value = '';
          var pvw = data.preview && data.preview.length > 0 ? '\n\nApercu: ' + data.preview.join(', ') : '';
          showModal('Filtre', 'Sauvegarde ! ' + data.count + ' mots-cles dans le cache.' + pvw, 'success');
        } else {
          var err = await res.json().catch(function(){ return {}; });
          showModal('Erreur', err.error || 'Impossible de sauvegarder', 'error');
        }
      } catch (err) {
        showModal('Erreur', err.message || 'Une erreur est survenue', 'error');
      }
    }

    function openFilterListModal() {
      document.getElementById('modal-filter-pick').classList.remove('hidden');
      document.getElementById('modal-filter-pick').classList.add('flex');
      fpTargetId = -1;
      document.getElementById('fp-owner').value = 'mine';
      loadFilterList();
    }

    function loadFilterIntoPanel(filterId) {
      if (LOCAL_MODE) { showModal('Filtre', 'Apercu indisponible en mode local', 'error'); return; }
      fetch(API + '/filters/' + filterId + '/preview').then(function(res){
        return res.json();
      }).then(function(data){
        if (data.filter_type === 'union') {
          // Union filter: show union info in the name, don't apply config
          resetFilters();
          loadedFilterId = filterId;
          var nameEl = document.getElementById('filter-loaded-name');
          var memberNames = (data.union_members || []).map(function(m){ return m.name; }).join(', ');
          nameEl.textContent = '[Union] ' + (data.name || '') + ' (' + (data.total || 0) + ' kw) → ' + memberNames;
          nameEl.classList.remove('hidden');
          document.getElementById('btn-filter-save').classList.add('hidden');
          document.getElementById('btn-filter-discard').classList.remove('hidden');
        } else {
          applyFilterConfig(data.config || {});
          loadedFilterId = filterId;
          var nameEl = document.getElementById('filter-loaded-name');
          nameEl.textContent = data.name || 'Filtre';
          nameEl.classList.remove('hidden');
          document.getElementById('btn-filter-save').classList.remove('hidden');
          document.getElementById('btn-filter-discard').classList.remove('hidden');
        }
        closeFilterPick();
      }).catch(function(){});
    }


    // === Presets IA + Styles + Enhance ===

    // -- Presets --

    function toggleMergedSettings() {
      if (LOCAL_MODE) { showModal('Parametres', 'Indisponible en mode local', 'error'); return; }
      var m = document.getElementById('modal-user-settings');
      var open = !m.classList.contains('hidden');
      if (open) { closeMergedSettings(); return; }
      m.classList.remove('hidden');
      m.classList.add('flex');
      makeModalDraggable('usettings-modal-header', 'usettings-modal');
      var providerBtn = m.querySelector('.tab-btn[data-tab="provider"]');
      switchSettingsTab('provider', providerBtn || m.querySelector('.tab-btn'));
      loadPresets();
      loadApiKeySettings();
      if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'kw_editor')) {
        document.getElementById('preset-global-label').style.display = '';
      }
    }

    function closeMergedSettings() {
      document.getElementById('modal-user-settings').classList.add('hidden');
      document.getElementById('modal-user-settings').classList.remove('flex');
    }

    async function loadApiKeySettings() {
      loadApiKey();
    }

    async function _loadApiKeySettings() {
      // Variante historique (non appelée dans le pack) : on délègue au
      // chargeur canonique d'app-admin.js qui applique le garde-fou
      // anti-masque — le masque va dans `placeholder`, jamais dans la valeur.
      return loadApiKeySettings();
    }

    function switchSettingsTab(tab, btn) {
      document.querySelectorAll('#modal-user-settings .tab-content').forEach(function(el){ el.classList.add('hidden'); });
      document.querySelectorAll('#modal-user-settings .tab-btn').forEach(function(el){
        el.classList.remove('text-indigo-600', 'dark:text-indigo-400', 'border-indigo-500', 'dark:border-indigo-400');
        el.classList.add('text-slate-500', 'dark:text-slate-400', 'border-transparent');
      });
      document.getElementById('tab-' + tab).classList.remove('hidden');
      if (tab === 'blobby') _blobbyPopulateSettings();
      btn.classList.remove('text-slate-500', 'dark:text-slate-400', 'border-transparent');
      btn.classList.add('text-indigo-600', 'dark:text-indigo-400', 'border-indigo-500', 'dark:border-indigo-400');
    }

    async function loadStylesTab() {
      var el = document.getElementById('styles-tab-list');
      try {
        var res = await fetch(API + '/styles');
        var list = await safeJson(res);
        if (!Array.isArray(list)) { el.innerHTML = '<p class="text-xs text-slate-400">Aucun style</p>'; return; }
        var html = '';
        list.forEach(function(s){
          var name = escapeHtml(s.name || '?');
          var author = escapeHtml(s.owner_name || '?');
          var pub = s.is_public ? ' 🌐' : ' 🔒';
          var canEdit = s.user_id === (currentUser ? currentUser.id : '') || (currentUser && (currentUser.role === 'admin' || currentUser.role === 'kw_editor') && !s.user_id);
          var canClone = canEdit || (s.is_public && currentUser && s.user_id !== currentUser.id);
          html += '<div class="aih-style-row flex flex-col px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-700' +
            (canEdit || canClone ? ' cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700' : '') +
            '" onclick="editStyleTab(' + s.id + ')" title="Cliquer pour editer">' +
            '<div class="flex items-center justify-between">' +
            '<div><span class="text-xs font-medium text-slate-700 dark:text-slate-300">' + name + '</span>' +
            '<span class="text-xs text-slate-400 ml-2">par ' + author + pub + '</span></div>' +
            '<div class="flex gap-1 shrink-0 ml-2" onclick="event.stopPropagation()">';
          if (canClone) {
            html += '<button onclick="cloneStyleTab(' + s.id + ')" class="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md bg-indigo-50 text-indigo-600 border border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800/50 dark:hover:bg-indigo-900/50 transition" title="Cloner">📋 Cloner</button>';
          }
          if (canEdit) {
            html += '<button onclick="deleteStyle(' + s.id + ')" class="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50 dark:hover:bg-red-900/50 transition" title="Supprimer">🗑 Supprimer</button>';
          }
          html += '</div></div></div>';
        });
        el.innerHTML = html || '<p class="text-xs text-slate-400">Aucun style</p>';
      } catch { el.innerHTML = '<p class="text-xs text-red-400">Erreur de chargement</p>'; }
    }

    function closeUserSettings() {
      document.getElementById('modal-user-settings').classList.add('hidden');
      document.getElementById('modal-user-settings').classList.remove('flex');
    }

    function checkPresetUrl() {
      var url = document.getElementById('preset-form-url').value.trim();
      var warn = document.getElementById('preset-url-warning');
      var isLocal = /(localhost|127\.0\.0\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+)/i.test(url);
      if (isLocal) warn.classList.remove('hidden');
      else warn.classList.add('hidden');
    }

    function clearPresetForm() {
      document.getElementById('preset-form-name').value = '';
      document.getElementById('preset-form-url').value = '';
      document.getElementById('preset-form-key').value = '';
      document.getElementById('preset-form-model').value = '';
      document.getElementById('preset-form-key').placeholder = 'API Key (optionnel)';
      document.getElementById('preset-form-global').checked = false;
      document.getElementById('preset-models-datalist').innerHTML = '';
    }

    async function loadPresets() {
      if (LOCAL_MODE) return;   // /presets indisponible en local
      try {
        var res = await fetch(API + '/presets');
        if (!res.ok) {
          var txt = await res.text().catch(function(){ return ''; });
          console.error('loadPresets failed:', res.status, txt.substring(0,200));
          return;
        }
        var presets = await res.json();
        renderPresetsList(presets);
        // Remplir le dropdown de l'enhancer
        var sel = document.getElementById('enhance-preset');
        sel.innerHTML = '<option value="">-- Preset IA --</option>';
        presets.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name + (p.is_global ? ' 🌐' : '') + (p.is_client_side ? ' 🖥️' : '');
          sel.appendChild(opt);
        });
        // Restaurer si sauvegarde
        if (currentUser && currentUser.settings && currentUser.settings.enhancePresetId) {
          sel.value = currentUser.settings.enhancePresetId;
        }
      } catch (e) {}
    }

    function renderPresetsList(presets) {
      var el = document.getElementById('presets-list');
      if (!presets.length) { el.innerHTML = '<p class="text-xs text-slate-400">Aucun preset. Creez-en un !</p>'; return; }
      var html = '';
      presets.forEach(function(p) {
        var canEdit = (!p.is_global && p.user_id === (currentUser ? currentUser.id : '')) || (currentUser && (currentUser.role === 'admin' || currentUser.role === 'kw_editor'));
        html += '<div class="flex items-center justify-between py-1 px-2 rounded text-xs ' + (p.is_global ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-slate-50 dark:bg-slate-800/50') + '">';
        html += '<div><span class="font-medium text-slate-700 dark:text-slate-200">' + escapeHtml(p.name) + '</span>';
        if (p.is_global) html += ' <span class="text-indigo-500">🌐 global</span>';
        if (p.is_client_side) html += ' <span class="text-amber-500">🖥️ client</span>';
        if (p.owner_name && !p.is_global) html += ' <span class="text-slate-400">(' + escapeHtml(p.owner_name) + ')</span>';
        html += '<br><span class="text-slate-400">' + escapeHtml(p.model) + ' @ ' + escapeHtml(p.base_url) + '</span></div>';
        html += '<div class="flex gap-1">';
        if (canEdit) {
          html += '<button onclick="editPreset(' + p.id + ')" class="text-xs text-indigo-500 hover:text-indigo-700">Edit</button>';
          html += '<button onclick="dupPreset(' + p.id + ')" class="text-xs text-slate-400 hover:text-slate-600">Dup</button>';
          html += '<button onclick="delPreset(' + p.id + ')" class="text-xs text-rose-400 hover:text-rose-600">Del</button>';
        }
        html += '</div></div>';
      });
      el.innerHTML = html;
    }

    function editPreset(id) {
      if (LOCAL_MODE) return;
      // Charger dans le formulaire (besoin de refaire un fetch)
      fetch(API + '/presets').then(function(r){ return r.json(); }).then(function(ps){
        var p = ps.find(function(x){ return x.id === id; });
        if (!p) return;
        document.getElementById('preset-form-name').value = p.name;
        document.getElementById('preset-form-url').value = p.base_url;
        document.getElementById('preset-form-model').value = p.model;
        document.getElementById('preset-form-key').value = '';
        document.getElementById('preset-form-key').placeholder = '••••••• (inchangé)';
        document.getElementById('preset-form-global').checked = p.is_global;
        // Stocker l'ID pour un update
        document.getElementById('preset-form-name').dataset.editId = id;
      }).catch(function(){});
    }

    async function savePreset() {
      if (LOCAL_MODE) { showModal('Preset', 'Indisponible en mode local', 'error'); return; }
      var name = document.getElementById('preset-form-name').value.trim();
      var url = document.getElementById('preset-form-url').value.trim();
      var key = document.getElementById('preset-form-key').value.trim();
      var model = document.getElementById('preset-form-model').value.trim();
      var isGlobal = document.getElementById('preset-form-global').checked ? 1 : 0;
      var isClient = document.getElementById('preset-form-client').checked ? 1 : 0;
      var editId = document.getElementById('preset-form-name').dataset.editId;

      if (!name) { showModal('Preset', 'Nom requis', 'error'); return; }
      if (!url) { showModal('Preset', 'URL requise', 'error'); return; }

      try {
        var body = { name: name, base_url: url, api_key: key, model: model, is_global: isGlobal, is_client_side: isClient };
        var method = 'POST';
        var endpoint = '/presets';
        if (editId) {
          method = 'PUT';
          endpoint = '/presets/' + editId;
          if (!key) delete body.api_key;  // garder l'ancienne cle si vide
        }
        var res = await fetch(API + endpoint, {
          method: method,
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });
        if (!res.ok) throw await safeJson(res);
        clearPresetForm();
        document.getElementById('preset-form-name').dataset.editId = '';
        loadPresets();
        showModal('Preset', editId ? 'Preset mis a jour' : 'Preset cree', 'success');
      } catch (err) {
        showModal('Erreur', (err.error || err.message || 'Erreur'), 'error');
      }
    }

    async function dupPreset(id) {
      if (LOCAL_MODE) { showModal('Preset', 'Indisponible en mode local', 'error'); return; }
      try {
        var res = await fetch(API + '/presets/' + id + '/duplicate', { method: 'POST' });
        if (!res.ok) throw await safeJson(res);
        loadPresets();
        showModal('Preset', 'Preset duplique', 'success');
      } catch (err) {
        showModal('Erreur', (err.error || ''), 'error');
      }
    }

    async function delPreset(id) {
      if (LOCAL_MODE) { showModal('Preset', 'Indisponible en mode local', 'error'); return; }
      showConfirm('Supprimer', 'Supprimer ce preset ?', async function(ok){
        if (!ok) return;
        try {
          var res = await fetch(API + '/presets/' + id, { method: 'DELETE' });
          if (!res.ok) throw await safeJson(res);
          loadPresets();
        } catch (err) {}
      });
    }

    async function fetchModelsForForm() {
      if (LOCAL_MODE) { showModal('Modeles', 'Indisponible en mode local', 'error'); return; }
      var url = document.getElementById('preset-form-url').value.trim();
      var key = document.getElementById('preset-form-key').value.trim();
      var isClient = document.getElementById('preset-form-client').checked;
      if (!url) { showModal('URL', 'Saisis l\'URL du serveur d\'abord', 'error'); return; }

      try {
        var models;
        if (isClient) {
          // ── Mode client-side coche : appel direct depuis le navigateur ──────────
          // (necessite CORS active cote serveur LLM, defaut pour Ollama, LM Studio, etc.)
          var headers = {'Content-Type': 'application/json'};
          if (key) headers['Authorization'] = 'Bearer ' + key;
          var r = await fetch(url.replace(/\/+$/, '') + '/models', { headers: headers });
          if (!r.ok) {
            var errText = await r.text().catch(function(){ return ''; });
            throw { error: 'HTTP ' + r.status + (errText ? ': ' + errText.substring(0, 200) : ' — verifie que CORS est active sur le serveur LLM') };
          }
          var data = await r.json();
          // Format OpenAI standard : {data: [{id, owned_by}, ...]}
          // Certains serveurs (Ollama) utilisent {models: [{name, ...}]}
          var raw = (data && data.data) || (data && data.models) || [];
          models = raw.map(function(m) {
            if (typeof m === 'string') return { id: m, owned_by: '' };
            return { id: m.id || m.name || '', owned_by: m.owned_by || '' };
          });
        } else {
          // ── Mode cloud : le backend fait l'appel ──────────
          var r2 = await fetch(API + '/presets/list-models', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ base_url: url, api_key: key })
          });
          if (!r2.ok) throw await safeJson(r2);
          models = await safeJson(r2);
        }
        var dl = document.getElementById('preset-models-datalist');
        dl.innerHTML = '';
        models.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.id + (m.owned_by ? ' (' + m.owned_by + ')' : '');
          dl.appendChild(opt);
        });
        if (models.length === 0) showModal('Modeles', 'Aucun modele trouve', 'error');
      } catch (e) {
        showModal('Erreur', (e.error || e.message || 'Impossible de lister les modeles'), 'error');
      }
    }

    function exportStyle() {
      var name = document.getElementById('t-style-form-name').value.trim() || 'style';
      var text = document.getElementById('t-style-form-text').value;
      var neg = document.getElementById('t-style-form-neg').value;
      var blob = new Blob([text + (neg ? '\n\nNEGATIVE:\n' + neg : '')], {type: 'text/plain'});
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'style_' + name.replace(/[^a-zA-Z0-9]/g, '_') + '.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // -- Templates Prompt --

    function renderExamples(examples) {
      var container = document.getElementById('tmpl-examples-list');
      if (!examples || examples.length === 0) {
        container.innerHTML = '<p class="text-xs text-slate-400 italic">Aucun exemple</p>';
        return;
      }
      container.innerHTML = examples.map(function(ex, i) {
        return '<div class="flex items-start gap-1.5 p-1.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">'
          + '<span class="flex-1 text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap" style="word-break:break-word;">' + escapeHtml(ex) + '</span>'
          + '<button onclick="removeTemplateExample(' + i + ')" class="text-xs text-rose-400 hover:text-rose-600 p-0.5">✕</button>'
          + '</div>';
      }).join('');
    }

    function getExamples() {
      var items = document.querySelectorAll('#tmpl-examples-list > div');
      var examples = [];
      items.forEach(function(div) {
        var span = div.querySelector('span');
        if (span) examples.push(span.textContent);
      });
      return examples;
    }

    function addTemplateExample() {
      var input = document.getElementById('tmpl-example-input');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      var examples = getExamples();
      examples.push(text);
      renderExamples(examples);
    }

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'tmpl-example-input') {
        addTemplateExample();
      }
    });

    function removeTemplateExample(idx) {
      var examples = getExamples();
      examples.splice(idx, 1);
      renderExamples(examples);
    }

    // === Liste des templates (gauche) ===
    async function loadTemplatesTab() {
      var el = document.getElementById('templates-tab-list');
      try {
        var res = await fetch(API + '/prompts/templates');
        var list = await safeJson(res);
        if (!Array.isArray(list)) { el.innerHTML = '<p class="text-xs text-slate-400">Aucun template</p>'; return; }
        var html = '';
        list.forEach(function(t){
          var name = escapeHtml(t.name || ('Template ' + t.id));
          var author = escapeHtml(t.owner_name || '—');
          var pub = t.is_public ? ' 🌐' : ' 🔒';
          var isDefault = !!t.is_default;
          var isAdmin = currentUser && currentUser.role === 'admin';
          var canEdit = t.editable || isAdmin;
          html += '<div class="aih-tmpl-row flex items-center justify-between px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700' +
            '" onclick="editTemplateTab(' + t.id + ')" title="Cliquer pour editer">' +
            '<div><span class="text-xs font-medium text-slate-700 dark:text-slate-300">' + name + '</span>' +
            '<span class="text-xs text-slate-400 ml-2">par ' + author + pub + '</span></div>' +
            '<div class="flex gap-1 shrink-0 ml-2" onclick="event.stopPropagation()">';
          if (canEdit) {
            html += '<button onclick="cloneTemplateTab(' + t.id + ')" class="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md bg-indigo-50 text-indigo-600 border border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800/50 dark:hover:bg-indigo-900/50 transition" title="Cloner">📋 Cloner</button>';
            html += '<button onclick="deleteTemplateTab(' + t.id + ')" class="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50 dark:hover:bg-red-900/50 transition" title="Supprimer">🗑 Supprimer</button>';
          }
          html += '</div></div>';
        });
        el.innerHTML = html || '<p class="text-xs text-slate-400 italic">Aucun template. Clique sur "+ Nouveau template".</p>';
      } catch { el.innerHTML = '<p class="text-xs text-red-400">Erreur de chargement</p>'; }
    }

    // === Edition (droite) ===
    function newTemplateTab() {
      document.getElementById('tmpl-name').value = '';
      document.getElementById('tmpl-name').dataset.editId = '';
      document.getElementById('tmpl-format').value = 'text';
      document.getElementById('tmpl-system-prompt').value = '';
      document.getElementById('tmpl-public').checked = false;
      document.getElementById('btn-tmpl-save').textContent = 'Sauvegarder';
      document.getElementById('btn-tmpl-clear').classList.remove('hidden');
      renderExamples([]);
    }

    function editTemplateTab(id) {
      fetch(API + '/prompts/templates').then(function(r){ return r.json(); }).then(function(list){
        var t = list.find(function(x){ return x.id === id; });
        if (!t) return;
        document.getElementById('tmpl-name').value = t.name || '';
        document.getElementById('tmpl-format').value = t.output_format || 'text';
        document.getElementById('tmpl-system-prompt').value = t.system_prompt || '';
        document.getElementById('tmpl-public').checked = !!t.is_public;
        var isDef = !!t.is_default;
        // Pour les templates systeme, on ne met pas d'editId → POST = creation
        if (isDef) {
          document.getElementById('tmpl-name').dataset.editId = '';
          document.getElementById('btn-tmpl-save').textContent = 'Sauvegarder';
        } else {
          document.getElementById('tmpl-name').dataset.editId = t.editable ? id : '';
          document.getElementById('btn-tmpl-save').textContent = t.editable ? 'Mettre à jour' : 'Sauvegarder';
        }
        document.getElementById('btn-tmpl-clear').classList.remove('hidden');
        renderExamples(t.examples || []);
      }).catch(function(){});
    }

    function cloneTemplateTab(id) {
      fetch(API + '/prompts/templates').then(function(r){ return r.json(); }).then(function(list){
        var t = list.find(function(x){ return x.id === id; });
        if (!t) return;
        document.getElementById('tmpl-name').value = (t.name || '') + ' (copie)';
        document.getElementById('tmpl-name').dataset.editId = '';
        document.getElementById('tmpl-format').value = t.output_format || 'text';
        document.getElementById('tmpl-system-prompt').value = t.system_prompt || '';
        document.getElementById('tmpl-public').checked = false;
        document.getElementById('btn-tmpl-save').textContent = 'Sauvegarder';
        document.getElementById('btn-tmpl-clear').classList.remove('hidden');
        renderExamples(t.examples || []);
      }).catch(function(){});
    }

    async function deleteTemplateTab(id) {
      if (LOCAL_MODE) { showModal('Template', 'Suppression indisponible en mode local', 'error'); return; }
      if (!confirm('Supprimer ce template ?')) return;
      try {
        var res = await fetch(API + '/prompts/templates/' + id, { method: 'DELETE' });
        if (!res.ok) throw await safeJson(res);
        loadTemplatesTab();
        clearTemplateFormTab();
      } catch (err) {
        showModal('Erreur', 'Impossible de supprimer: ' + (err.message || err.error || ''), 'error');
      }
    }

    async function saveTemplateTab() {
      if (LOCAL_MODE) { showModal('Template', 'Sauvegarde indisponible en mode local', 'error'); return; }
      var name = document.getElementById('tmpl-name').value.trim();
      var fmt = document.getElementById('tmpl-format').value;
      var sys = document.getElementById('tmpl-system-prompt').value;
      var examples = getExamples();
      var isPublic = document.getElementById('tmpl-public').checked;
      var editId = document.getElementById('tmpl-name').dataset.editId;

      if (!name) { showModal('Template', 'Nom requis', 'error'); return; }

      try {
        var body = {
          name: name,
          output_format: fmt,
          system_prompt: sys,
          examples: examples,
          is_public: isPublic
        };
        var endpoint = '/prompts/templates';
        var method = 'POST';
        if (editId) { endpoint = '/prompts/templates/' + editId; method = 'PUT'; }
        var res = await fetch(API + endpoint, {
          method: method,
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });
        if (!res.ok) throw await safeJson(res);
        showModal('Template', editId ? 'Template mis à jour' : 'Template sauvegardé !', 'success');
        loadTemplatesTab();
        document.getElementById('btn-tmpl-save').textContent = 'Mettre à jour';
      } catch (err) {
        showModal('Erreur', (err.error || err.message || 'Erreur de sauvegarde'), 'error');
      }
    }

    function clearTemplateFormTab() {
      document.getElementById('tmpl-name').value = '';
      document.getElementById('tmpl-name').dataset.editId = '';
      document.getElementById('tmpl-system-prompt').value = '';
      document.getElementById('tmpl-public').checked = false;
      document.getElementById('btn-tmpl-save').textContent = 'Sauvegarder';
      document.getElementById('btn-tmpl-clear').classList.add('hidden');
      renderExamples([]);
    }

    function exportTemplate() {
      var name = document.getElementById('tmpl-name').value.trim() || 'template';
      var fmt = document.getElementById('tmpl-format').value;
      var sys = document.getElementById('tmpl-system-prompt').value;
      var examples = getExamples();
      var isPublic = document.getElementById('tmpl-public').checked;
      var data = {
        name: name,
        output_format: fmt,
        system_prompt: sys,
        examples: examples,
        is_public: isPublic
      };
      var blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'template_' + name.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // -- Styles (dropdown du generator uniquement) --

    async function loadStyles() {
      try {
        var r = await fetch(API + '/styles');
        if (!r.ok) {
          var txt2 = await r.text().catch(function(){ return ''; });
          console.error('loadStyles failed:', r.status, txt2.substring(0,200));
          return;
        }
        var styles = await r.json();
        var sel = document.getElementById('enhance-style');
        sel.innerHTML = '<option value="">-- Style --</option>';
        styles.forEach(function(s) {
          var opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name + (s.is_public ? '' : ' (prive)') + ' - ' + (s.owner_name || 'moi');
          sel.appendChild(opt);
        });
        if (currentUser && currentUser.settings && currentUser.settings.enhanceStyleId) {
          sel.value = currentUser.settings.enhanceStyleId;
        }
      } catch (e) {}
    }


    // --- Gestion des filtres ---

    function openManageFilters() {
      document.getElementById('modal-manage-filters').classList.remove('hidden');
      document.getElementById('modal-manage-filters').classList.add('flex');
      makeModalDraggable('mf-modal-header', 'mf-modal');
      mfSelected = {};
      var ub = document.getElementById('mf-union-btn');
      if (ub) ub.style.display = 'none';
      loadManageFilters();
    }

    function closeManageFilters() {
      document.getElementById('modal-manage-filters').classList.add('hidden');
      document.getElementById('modal-manage-filters').classList.remove('flex');
    }

    var mfSelected = {};

    function mfToggleSelect(id) {
      if (mfSelected[id]) delete mfSelected[id];
      else mfSelected[id] = true;
      document.getElementById('mf-union-btn').style.display = Object.keys(mfSelected).length >= 2 ? 'inline-flex' : 'none';
    }

    async function mfCreateUnion() {
      if (LOCAL_MODE) { showModal('Union', 'Indisponible en mode local', 'error'); return; }
      var ids = Object.keys(mfSelected).map(Number);
      if (ids.length < 2) { showModal('Union', 'Selectionne au moins 2 filtres', 'error'); return; }
      showPrompt('Union', 'Nom du filtre compose (union) :', 'Union: ...', async function(name) {
        if (!name) return;
        try {
          var res = await fetch(API + '/filters', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              name: name,
              filter_type: 'union',
              union_member_ids: ids,
              nsfw: 0,
              is_public: 0,
              category: '',
              config: {}
            })
          });
          if (res.ok) {
            showModal('Union', 'Filtre compose cree !', 'success');
            mfSelected = {};
            loadManageFilters();
          } else {
            var err = await safeJson(res);
            showModal('Erreur', err.error || 'Erreur', 'error');
          }
        } catch (err) {
          showModal('Erreur', err.message, 'error');
        }
      });
    }

    async function loadManageFilters() {
      try {
        var r = await fetch(API + '/filters');
        if (!r.ok) return;
        var filters = await r.json();
        var el = document.getElementById('mf-list');
        if (!filters.length) { el.innerHTML = '<p class="text-xs text-slate-400">Aucun filtre</p>'; return; }
        var html = '';
        html += '<div class="flex items-center gap-2 px-1 pb-2 border-b border-slate-200 dark:border-slate-700">';
        html += '<button id="mf-union-btn" onclick="mfCreateUnion()" class="hidden inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-md hover:bg-indigo-200 transition dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50">&#x1f9ea; Creer une union</button>';
        html += '<span class="text-xs text-slate-400">(cochez 2+ filtres)</span></div>';
        filters.forEach(function(f) {
          var canEdit = f.user_id === (currentUser ? currentUser.id : '');
          var checked = mfSelected[f.id] ? 'checked' : '';
          var typeBadge = f.filter_type === 'union' ? '<span class="text-xs text-amber-500 font-medium">[Union]</span> ' : '<span class="text-xs text-slate-400">[Simple]</span> ';
          var membersHtml = '';
          if (f.filter_type === 'union' && f.union_members && f.union_members.length > 0) {
            membersHtml = '<br><span class="text-xs text-amber-500/70">→ ' + f.union_members.map(function(m){ return escapeHtml(m.name); }).join(', ') + '</span>';
          }
          html += '<div class="flex items-center justify-between py-1.5 px-2 rounded text-xs ' + (canEdit ? 'bg-slate-50 dark:bg-slate-800/50' : 'bg-slate-50/50 dark:bg-slate-800/30') + '">';
          html += '<div class="flex items-center gap-2 flex-1 min-w-0">';
          html += '<input type="checkbox" ' + checked + ' onchange="mfToggleSelect(' + f.id + ')" class="accent-indigo-500 flex-shrink-0">';
          html += '<div class="min-w-0"><span class="font-medium text-slate-700 dark:text-slate-200">' + escapeHtml(f.name) + '</span> ' + typeBadge;
          html += ' <span class="text-slate-400">' + (f.nsfw ? 'NSFW' : 'SFW') + (f.is_public ? ' public' : '') + '</span>';
          html += membersHtml + '</div></div>';
          html += '<div class="flex gap-1 flex-shrink-0">';
          if (canEdit) {
            html += '<button onclick="renameFilter(' + f.id + ')" class="text-xs text-indigo-400 hover:text-indigo-600">Edit</button>';
            html += '<button onclick="refreshFilterCache(' + f.id + ')" class="text-xs text-amber-400 hover:text-amber-600" title="Reconstruire le cache">&#x21bb;</button>';
            html += '<button onclick="deleteMFFilter(' + f.id + ')" class="text-xs text-rose-400 hover:text-rose-600">Del</button>';
          }
          html += '</div></div>';
        });
        el.innerHTML = html;
      } catch (e) {}
    }

    async function refreshFilterCache(id) {
      if (LOCAL_MODE) { showModal('Cache', 'Indisponible en mode local', 'error'); return; }
      try {
        var r = await fetch(API + '/filters/' + id + '/refresh', { method: 'POST' });
        if (!r.ok) throw await safeJson(r);
        showModal('Cache', 'Cache du filtre regenere', 'success');
        loadManageFilters();
      } catch (err) {
        showModal('Erreur', err.error || 'Erreur', 'error');
      }
    }

    function renameFilter(id) {
      if (LOCAL_MODE) { showModal('Filtre', 'Indisponible en mode local', 'error'); return; }
      showPrompt('Renommer', 'Nouveau nom :', '', async function(name) {
        if (!name) return;
        try {
          var r = await fetch(API + '/filters/' + id, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: name})
          });
          if (!r.ok) throw await safeJson(r);
          loadManageFilters();
          showModal('Filtre', 'Filtre renomme', 'success');
        } catch (err) {
          showModal('Erreur', err.error || '', 'error');
        }
      });
    }

    function deleteMFFilter(id) {
      if (LOCAL_MODE) { showModal('Filtre', 'Suppression indisponible en mode local', 'error'); return; }
      showConfirm('Supprimer', 'Supprimer ce filtre ?', async function(ok) {
        if (!ok) return;
        try {
          var r = await fetch(API + '/filters/' + id, { method: 'DELETE' });
          if (!r.ok) throw await safeJson(r);
          loadManageFilters();
          showModal('Filtre', 'Filtre supprime', 'success');
        } catch (err) {
          showModal('Erreur', err.error || '', 'error');
        }
      });
    }

    async function previewFilterCache(filterId) {
      if (LOCAL_MODE) return;   // /filters/:id/preview indisponible en local
      try {
        var r = await fetch(API + '/filters/' + filterId + '/preview');
        if (!r.ok) return;
        var d = await r.json();
        var kw = d.keywords && d.keywords.length > 0 ? d.keywords.slice(0,8).join(', ') : 'aucun' ;
        showModal('Cache du filtre', d.total + ' mots-cles dans le cache.\n\nEchantillon: ' + kw, 'success');
      } catch (e) {}
    }

    function clearStyleFormTab() {
      document.getElementById('t-style-form-name').value = '';
      document.getElementById('t-style-form-name').dataset.editId = '';
      document.getElementById('t-style-form-text').value = '';
      document.getElementById('t-style-form-neg').value = '';
      document.getElementById('t-style-form-public').checked = false;
      document.getElementById('btn-t-style-save').textContent = 'Ajouter';
      document.getElementById('btn-t-style-clear').classList.add('hidden');
    }

    function editStyleTab(id) {
      fetch(API + '/styles').then(function(r){ return r.json(); }).then(function(styles){
        var s = styles.find(function(x){ return x.id === id; });
        if (!s) return;
        document.getElementById('t-style-form-name').value = s.name;
        document.getElementById('t-style-form-name').dataset.editId = id;
        document.getElementById('t-style-form-text').value = s.style_text;
        document.getElementById('t-style-form-neg').value = s.negative_prompt || '';
        document.getElementById('t-style-form-public').checked = s.is_public;
        document.getElementById('btn-t-style-save').textContent = 'Mettre a jour';
        document.getElementById('btn-t-style-clear').classList.remove('hidden');
      }).catch(function(){});
    }

    function cloneStyleTab(id) {
      // Clone : charge le style dans l'editeur sans editId (sauvegarde = nouveau style)
      fetch(API + '/styles').then(function(r){ return r.json(); }).then(function(styles){
        var s = styles.find(function(x){ return x.id === id; });
        if (!s) return;
        document.getElementById('t-style-form-name').value = s.name + ' (copie)';
        document.getElementById('t-style-form-name').dataset.editId = '';
        document.getElementById('t-style-form-text').value = s.style_text;
        document.getElementById('t-style-form-neg').value = s.negative_prompt || '';
        document.getElementById('t-style-form-public').checked = s.is_public;
        document.getElementById('btn-t-style-save').textContent = 'Ajouter';
        document.getElementById('btn-t-style-clear').classList.remove('hidden');
      }).catch(function(){});
    }

    function newStyleTab() {
      clearStyleFormTab();
      document.getElementById('t-style-form-name').focus();
    }

    async function saveStyleTab() {
      if (LOCAL_MODE) { showModal('Style', 'Sauvegarde indisponible en mode local', 'error'); return; }
      var name = document.getElementById('t-style-form-name').value.trim();
      var text = document.getElementById('t-style-form-text').value.trim();
      var neg = document.getElementById('t-style-form-neg').value.trim();
      var isPublic = document.getElementById('t-style-form-public').checked ? 1 : 0;
      var editId = document.getElementById('t-style-form-name').dataset.editId;
      if (!name || !text) { showModal('Style', 'Nom et texte requis', 'error'); return; }
      try {
        var body = {name: name, style_text: text, negative_prompt: neg, is_public: isPublic};
        var endpoint = '/styles';
        var method = 'POST';
        if (editId) { endpoint = '/styles/' + editId; method = 'PUT'; }
        var r = await fetch(API + endpoint, {
          method: method,
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });
        if (!r.ok) throw await safeJson(r);
        clearStyleFormTab();
        loadStylesTab();
        loadStyles();
        showModal('Style', editId ? 'Style mis a jour' : 'Style ajoute !', 'success');
      } catch (err) {
        showModal('Erreur', (err.error || ''), 'error');
      }
    }

    function delStyle(id) {
      if (LOCAL_MODE) { showModal('Style', 'Suppression indisponible en mode local', 'error'); return; }
      showConfirm('Supprimer', 'Supprimer ce style ?', async function(ok){
        if (!ok) return;
        try {
          var r = await fetch(API + '/styles/' + id, { method: 'DELETE' });
          if (!r.ok) throw await safeJson(r);
          loadStyles();
        } catch (e) {
          showModal('Erreur', (e.error || e.message || 'Impossible de supprimer le style'), 'error');
        }
      });
    }

    // -- Enhance --

    /**
     * Appelle /api/enhance en mode client-side (LLM local).
     * Boucle multi-passes : pour chaque passe (1, 2, 3), on fait l'appel
     * Ollama local et on appelle /api/enhance/finish. Le backend peut
     * retourner awaiting_validation si une autre passe est necessaire.
     *
     * params: { text, preset_id, template_id, style_id, style_text,
     *           ep_elements, random_count, base_url, onProgress }
     * Retourne: { output, negative_prompt, model_used, debug_md }
     */
    async function callEnhanceLocalLLM(params) {
      if (LOCAL_MODE) throw { error: 'Indisponible en mode local' };
      var baseUrl = (params.base_url || '').replace(/\/+$/, '');
      if (!baseUrl) throw { error: 'URL du LLM local manquante' };

      // 1) /api/enhance/prepare : le backend construit le payload LLM passe 1
      if (params.onProgress) params.onProgress('Preparation du prompt (backend)...');
      var prepareBody = {
        text: params.text,
        preset_id: params.preset_id,
        template_id: params.template_id,
        style_id: params.style_id,
        style_text: params.style_text,
        ep_elements: params.ep_elements || [],
        random_count: params.random_count || 0,
        output_format: params.output_format || 'rich'
      };
      var prepareRes = await fetch(API + '/enhance/prepare', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(prepareBody)
      });
      if (!prepareRes.ok) {
        var err = await safeJson(prepareRes);
        throw { error: (err && err.error) || ('HTTP ' + prepareRes.status) };
      }
      var prep = await prepareRes.json();

      // 2) Boucle multi-passes
      var pass = 1;
      while (true) {
        if (params.onProgress) {
          if (pass === 1) params.onProgress('Appel LLM local (passe 1)...');
          else params.onProgress('Validation LLM local (passe ' + pass + ')...');
        }
        // Appel direct a Ollama local (ou tout LLM OpenAI-compatible)
        var llmUrl = baseUrl + '/chat/completions';
        var llmHeaders = {'Content-Type': 'application/json'};
        // Note : la cle API est deja dans llm_config.api_key, donc pas d'auth
        // explicite ici. Le backend l'a mise dans llm_config mais on ne l'utilise
        // pas car Ollama local n'en a pas besoin. Si un user met une cle custom
        // (ex: LM Studio avec auth), il faudrait l'ajouter ici.
        var llmRes = await fetch(llmUrl, {
          method: 'POST',
          headers: llmHeaders,
          body: JSON.stringify(prep.llm_request)
        });
        if (!llmRes.ok) {
          var errText = await llmRes.text().catch(function(){ return ''; });
          throw { error: 'LLM local erreur ' + llmRes.status + (errText ? ': ' + errText.substring(0, 200) : ' — verifie que CORS est active sur le serveur LLM') };
        }
        var llmResponse = await llmRes.json();

        // 3) /api/enhance/finish : le backend fait le post-traitement
        if (params.onProgress) params.onProgress('Post-traitement (backend)...');
        var finishRes = await fetch(API + '/enhance/finish', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            session_id: prep.session_id,
            llm_response: llmResponse,
            pass: pass
          })
        });
        if (!finishRes.ok) {
          var ferr = await safeJson(finishRes);
          throw { error: (ferr && ferr.error) || ('HTTP ' + finishRes.status) };
        }
        var fin = await finishRes.json();

        // 4) Statut
        if (fin.status === 'done') {
          if (params.onProgress) params.onProgress('Terminé !');
          return {
            output: fin.output,
            negative_prompt: fin.negative_prompt,
            model_used: fin.model_used,
            debug_md: fin.debug_md
          };
        }
        if (fin.status === 'awaiting_validation') {
          // Le backend veut une autre passe : reboucle avec le nouveau llm_request
          prep.llm_request = fin.llm_request;
          pass = fin.pass;
          continue;
        }
        // Statut inconnu
        throw { error: 'Statut inattendu du backend: ' + fin.status };
      }
    }

    async function doEnhance() {
      if (LOCAL_MODE) { showModal('Enhance', 'Generation indisponible en mode local', 'error'); return; }
      var text = document.getElementById('enhance-input').value.trim();
      var presetId = document.getElementById('enhance-preset').value;
      var outputFormat = document.getElementById('enhance-format').value || 'rich';
      var promptType = document.getElementById('enhance-type').value;
      var templateId = promptType ? parseInt(promptType) : null;
      var styleId = document.getElementById('enhance-style').value;
      var useEP = document.getElementById('enhance-ep').checked;
      var useRandom = document.getElementById('enhance-random').checked;
      var randomCount = parseInt(document.getElementById('enhance-random-count').value) || 3;

      if (!text && !useEP) { showModal('Enhance', 'Saisis un texte ou active Elements Picker', 'error'); return; }

      var statusEl = document.getElementById('enhance-status');
      statusEl.textContent = 'Generation en cours...';
      statusEl.classList.remove('hidden');

      // Si Elements Picker active, generer et fusionner
      var epItems = [];
      if (useEP) {
        for (var i = 0; i < genElements.length; i++) {
          var el = genElements[i];
          if (el.type === 'filter' && el.filterId) epItems.push({type: 'filter', id: el.filterId});
          else if (el.type === 'text' && el.text) epItems.push({type: 'text', text: el.text});
        }
        // Afficher aussi dans l'output de l'Elements Picker
        try {
          var epRes = await fetch(API + '/generate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({elements: epItems})
          });
          if (epRes.ok) {
            var epData = await epRes.json();
            document.getElementById('gen-output').value = epData.prompt;
          }
        } catch (e) {}
      }

      // Recuperer le texte du style
      var styleText = '';
      if (styleId) {
        try {
          var sr = await fetch(API + '/styles');
          if (sr.ok) {
            var styles = await sr.json();
            var s = styles.find(function(x){ return x.id === parseInt(styleId); });
            if (s) styleText = s.style_text;
          }
        } catch (e) {}
      }

      // Verifier si le preset est client-side
      var isClientSide = false;
      var csUrl = '', csModel = '';
      if (presetId) {
        try {
          var pr = await fetch(API + '/presets');
          if (pr.ok) {
            var presets = await pr.json();
            var p = presets.find(function(x){ return x.id === parseInt(presetId); });
            if (p && p.is_client_side) {
              isClientSide = true;
              csUrl = p.base_url || '';
              csModel = p.model || '';
            }
          }
        } catch (e) {}
      }

      try {
        var data;
        if (isClientSide && csUrl) {
          // ── Mode client-side (LLM local) : boucle multi-passes ──────────
          // On utilise /api/enhance/prepare (construit le payload LLM cote backend
          // avec tous les templates/system_prompt/exemples), puis on fait les appels
          // Ollama local directement depuis le navigateur, puis /api/enhance/finish
          // orchestre les passes de validation.
          data = await callEnhanceLocalLLM({
            text: text,
            preset_id: presetId ? parseInt(presetId) : null,
            template_id: templateId,
            style_id: styleId ? parseInt(styleId) : null,
            style_text: styleText,
            ep_elements: epItems,
            random_count: useRandom ? randomCount : 0,
            output_format: outputFormat,
            base_url: csUrl,
            onProgress: function(msg) { statusEl.textContent = msg; }
          });
        } else {
          // Appel via backend (streaming ndjson : keepalive + result final)
          var body = {
            text: text,
            preset_id: presetId ? parseInt(presetId) : null,
            template_id: templateId,
            style_id: styleId ? parseInt(styleId) : null,
            style_text: styleText,
            ep_elements: epItems,
            random_count: useRandom ? randomCount : 0,
            output_format: outputFormat
          };
          var res = await fetch(API + '/enhance', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
          });
          if (!res.ok) throw await safeJson(res);
          // Lire les chunks ndjson et garder le dernier status='done'
          var text2 = await res.text();
          data = {output: ''};
          for (var i = 0; i < text2.split('\n').length; i++) {
            var line = text2.split('\n')[i];
            if (!line.trim()) continue;
            try {
              var chunk = JSON.parse(line);
              if (chunk.status === 'done') {
                data = chunk;
              } else if (chunk.status === 'error') {
                throw {error: chunk.error || 'Erreur LLM'};
              }
            } catch (e) {
              if (e && e.error) throw e;
              // sinon ignorer la ligne (parse error)
            }
          }
        }
        document.getElementById('enhance-output').value = data.output;
        document.getElementById('btn-copy-enhance').classList.remove('hidden');
        document.getElementById('btn-toggle-view').classList.remove('hidden');
        statusEl.classList.add('hidden');
        saveEnhancerSettings();
      } catch (err) {
        statusEl.classList.add('hidden');
        showModal('Erreur', (err.error || 'Erreur de generation'), 'error');
      }
    }

    // === P5 : Sync local (écritures en attente / conflits) ===
    // Bouton discret "🔄 Sync" dans la barre quand le frontend est servi en
    // mode local (window.LOCAL_MODE posé par app-core.js). Ouvre une modale
    // listant l'outbox (status pending/conflict/error + last_error) avec un
    // bouton "Forcer le sync" → GET /aih/local/api/sync/retry.

    (function() {
      var injected = false;

      function injectSyncButton() {
        if (injected || !window.LOCAL_MODE) return false;
        if (document.getElementById('aih-sync-btn')) { injected = true; return true; }
        // Point d'insertion : à côté du badge de mode local (avant user-area),
        // sinon dans le header en dernier recours.
        var userArea = document.getElementById('user-area');
        var parent = userArea && userArea.parentNode ? userArea.parentNode : (document.querySelector('header') || document.body);
        var ref = userArea || null;
        var btn = document.createElement('button');
        btn.id = 'aih-sync-btn';
        btn.type = 'button';
        btn.textContent = '🔄 Sync';
        btn.title = 'Écritures locales en attente / conflits';
        btn.style.cssText = 'font-size:11px;font-weight:500;padding:3px 8px;border-radius:6px;' +
          'background:rgba(0,0,0,.25);border:1px solid rgba(148,163,184,.4);color:#cbd5e1;' +
          'cursor:pointer;white-space:nowrap;';
        btn.addEventListener('click', openSyncModal);
        parent.insertBefore(btn, ref);
        injected = true;
        return true;
      }

      // La détection du mode local est asynchrone (probe /aih/local/status) :
      // on réessaie jusqu'à ce que window.LOCAL_MODE soit posé (ou que le badge
      // d'app-core apparaisse), puis on arrête le timer.
      function waitForLocalMode() {
        if (injectSyncButton()) return;
        var tries = 0;
        var timer = setInterval(function() {
          tries++;
          if (injectSyncButton() || tries > 25) clearInterval(timer);
        }, 400);
      }

      function buildSyncModal() {
        var existing = document.getElementById('aih-sync-modal');
        if (existing) return existing;
        var overlay = document.createElement('div');
        overlay.id = 'aih-sync-modal';
        overlay.className = 'hidden fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm';
        overlay.innerHTML =
          '<div class="bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden dark:bg-slate-800 dark:border-slate-700" style="width:520px;max-width:92vw;position:relative;">' +
          '  <div id="aih-sync-modal-header" class="border-b border-slate-200 bg-slate-50 px-5 py-3 flex items-center justify-between cursor-grab dark:border-slate-700 dark:bg-slate-800/80 select-none">' +
          '    <span class="text-sm font-semibold text-slate-800 dark:text-slate-200">Sync local</span>' +
          '    <button onclick="closeSyncModal()" class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700">&times;</button>' +
          '  </div>' +
          '  <div id="aih-sync-modal-body" class="p-4 overflow-y-auto space-y-2" style="max-height:55vh;"></div>' +
          '  <div class="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700">' +
          '    <button onclick="closeSyncModal()" class="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">Fermer</button>' +
          '    <button id="aih-sync-force-btn" onclick="forceSync()" class="px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-500">Forcer le sync</button>' +
          '  </div>' +
          '</div>';
        document.body.appendChild(overlay);
        if (typeof makeModalDraggable === 'function') {
          try { makeModalDraggable('aih-sync-modal-header', 'aih-sync-modal'); } catch (e) {}
        }
        return overlay;
      }

      function openSyncModal() {
        var overlay = buildSyncModal();
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        loadSyncData();
      }

      function closeSyncModal() {
        var overlay = document.getElementById('aih-sync-modal');
        if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('flex'); }
      }

      async function loadSyncData() {
        var body = document.getElementById('aih-sync-modal-body');
        if (!body) return;
        body.innerHTML = '<p class="text-xs text-slate-400">Chargement...</p>';
        try {
          var outRes = await fetch('/aih/local/api/sync/outbox');
          var outData = outRes.ok ? await outRes.json() : { items: [], count: 0, error: 'HTTP ' + outRes.status };
          var cfRes = await fetch('/aih/local/api/sync/conflicts');
          var cfData = cfRes.ok ? await cfRes.json() : { items: [], count: 0, error: 'HTTP ' + cfRes.status };
          renderSyncModal(outData, cfData);
        } catch (e) {
          body.innerHTML = '<p class="text-xs text-red-400">Erreur: ' + escapeHtml(e.message || e) + '</p>';
        }
      }

      function renderSyncModal(outData, cfData) {
        var body = document.getElementById('aih-sync-modal-body');
        if (!body) return;
        var items = (outData && outData.items) || [];
        var conflicts = (cfData && cfData.items) || [];
        var html = '';
        html += '<div class="text-xs font-semibold text-slate-700 dark:text-slate-300">Outbox — ' + items.length + ' opération(s)</div>';
        if (items.length === 0) {
          html += '<p class="text-xs text-slate-400">Aucune écriture en attente.</p>';
        } else {
          items.forEach(function(it) {
            html += '<div class="p-2 rounded-md bg-slate-50 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-600">' +
              '<div class="flex items-center justify-between gap-2 flex-wrap">' +
              '<span class="text-xs font-medium text-slate-700 dark:text-slate-200">' + escapeHtml(it.entity_type) + '</span>' +
              statusBadge(it.status) +
              '</div>' +
              '<div class="text-[11px] text-slate-400 mt-0.5">' +
              escapeHtml(it.op) + ' · ' + escapeHtml(it.entity_client_id || '') +
              (it.created_at ? ' · ' + escapeHtml(it.created_at) : '') +
              '</div>' +
              (it.last_error ? '<div class="text-[11px] text-rose-500 mt-1">' + escapeHtml(it.last_error) + '</div>' : '') +
              '</div>';
          });
        }
        html += '<div class="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-3">Conflits — ' + conflicts.length + '</div>';
        if (conflicts.length === 0) {
          html += '<p class="text-xs text-slate-400">Aucun conflit.</p>';
        } else {
          conflicts.forEach(function(c) {
            html += '<div class="p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">' +
              '<div class="flex items-center justify-between gap-2 flex-wrap">' +
              '<span class="text-xs font-medium text-amber-700 dark:text-amber-300">' + escapeHtml(c.table) + ' #' + escapeHtml(c.id) + '</span>' +
              '<span class="text-[10px] font-medium text-amber-600 dark:text-amber-400">conflict</span>' +
              '</div>' +
              '<div class="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5">' + escapeHtml(c.client_id || '') + (c.updated_at ? ' · ' + escapeHtml(c.updated_at) : '') + '</div>' +
              '</div>';
          });
        }
        body.innerHTML = html;
      }

      function statusBadge(status) {
        var s = (status || '').toLowerCase();
        var cls = 'text-slate-600 bg-slate-200 dark:text-slate-300 dark:bg-slate-600';
        if (s === 'pending') cls = 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40';
        else if (s === 'conflict' || s === 'error') cls = 'text-rose-700 bg-rose-100 dark:text-rose-300 dark:bg-rose-900/40';
        else if (s === 'applied') cls = 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/40';
        return '<span class="text-[10px] font-medium px-1.5 py-0.5 rounded ' + cls + '">' + escapeHtml(status || '?') + '</span>';
      }

      async function forceSync() {
        var btn = document.getElementById('aih-sync-force-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Sync en cours...'; }
        try {
          var res = await fetch('/aih/local/api/sync/retry');
          var data = await res.json().catch(function(){ return { error: 'HTTP ' + res.status }; });
          loadSyncData();
          if (typeof showModal === 'function') {
            showModal('Sync', data.error ? ('Erreur: ' + data.error) : ('Envoyées: ' + (data.sent||0) + ' · Appliquées: ' + (data.applied||0) + ' · Conflits: ' + (data.conflicts||0) + ' · Erreurs: ' + (data.errors||0)), data.error ? 'error' : 'success');
          }
        } catch (e) {
          if (typeof showModal === 'function') showModal('Sync', 'Erreur: ' + (e.message || e), 'error');
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Forcer le sync'; }
        }
      }

      // Exposer pour les handlers inline des boutons de la modale.
      window.closeSyncModal = closeSyncModal;
      window.forceSync = forceSync;

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForLocalMode);
      } else {
        waitForLocalMode();
      }
    })();
