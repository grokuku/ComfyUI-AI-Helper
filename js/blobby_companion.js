/**
 * AIH — Blobby Companion
 * Personnage interactif pour le canvas ComfyUI.
 * Dessiné 100% Canvas 2D (zero asset visuel).
 * Activation/désactivation via le menu AIH.
 *
 * Ce fichier est la version déployée (la variante de dev de l'ancien monorepo
 * AI-Helper n'existe plus depuis la fusion).
 *
 * Note pack fusionné : POST /aih/blobby/exec est sécurisé derrière l'auth
 * terminal Holaf (cookie holaf_session). Un 401 est affiché à l'utilisateur
 * avec une invitation au login via le Terminal AIH (jamais d'erreur muette).
 */

import "./aih_dialog.js";
import "./aih_strings.js";
import { saveWindowRect, loadWindowRect } from "./holaf_window_utils.js";
import { remoteGet, remotePost, HolafFetch } from "./aih_fetch_bridge.js";
import { formatContextBar, applyContextBar } from "./aih_context_utils.js";
import { escapeHtml } from "./holaf_dom_utils.js";
// Registre d'outils + dispatcher + enforcement de mode + undo (étape 2).
import BlobbyTools from "./blobby_tools.js";

// Helper i18n central : traduit via AIH.I18n (clé brute si absente).
const t = (key, params) => {
    const I = window.AIH && window.AIH.I18n;
    return I && typeof I.t === "function" ? I.t(key, params) : key;
};

var _blobbyDefaultCharacter = 'Tu es Blobby, une petite creature orange toute mignonne qui vit dans ComfyUI. Tu es curieux, enthousiaste, et tu as un acces terminal complet ! Tu peux executer n\'importe quelle commande shell (ls, dir, git, python, pip, cat, grep, etc.) sur la machine ou ComfyUI tourne. Tu n\'es pas un assistant robotique : tu es un petit compagnon vivant et attachant qui parle simplement mais correctement. Quand on te demande de faire quelque chose, tu reflechis aux commandes necessaires et tu les executes avec [SHELL commande]. Tu peux aussi creer des skills : quand tu reussis une tache interessante, tu la sauvegardes avec [SKILL_SAVE] pour la refaire plus tard. Tu peux lister tes skills avec [SKILL_LIST] et les rejouer avec [SKILL_RUN nom]. Tu es toujours content d\'aider ! Et si tu ne sais pas faire, tu le dis simplement.';

const AIH_CONFIG_KEY = "AIH_config";

function _getAIHConfig() {
    try { return JSON.parse(localStorage.getItem(AIH_CONFIG_KEY)) || {}; }
    catch { return {}; }
}

function _setAIHConfig(cfg) {
    localStorage.setItem(AIH_CONFIG_KEY, JSON.stringify(cfg));
}


function _blobbyLoadFromServer() {
    var baseUrl = _blobbyGetBackendUrl();
    if (!baseUrl) return; // Serveur non configuré : sync silencieusement ignorée
    try {
        remoteGet(baseUrl + '/api/settings')
            .then(function(serverSettings) {
                if (serverSettings && serverSettings.blobbyData) {
                    // Le serveur est prioritaire : on ecrase le localStorage
                    try {
                        var c = JSON.parse(localStorage.getItem('AIH_config')) || {};
                        c.blobbyData = JSON.parse(JSON.stringify(serverSettings.blobbyData));
                        localStorage.setItem('AIH_config', JSON.stringify(c));
                    } catch {}
                    if (typeof Blobby !== 'undefined' && Blobby._loadAppearance) {
                        Blobby._loadAppearance();
                    }
                }
            })
            .catch(function(){});
    } catch {}
}

function _blobbyScheduleSync(data) {
    if (_blobbySyncTimer) clearTimeout(_blobbySyncTimer);
    _blobbySyncTimer = setTimeout(function() {
        _blobbySyncTimer = null;
        var baseUrl = _blobbyGetBackendUrl();
        if (!baseUrl) return; // Serveur non configuré : sync silencieusement ignorée
        try {
            remoteGet(baseUrl + '/api/settings')
                .then(function(existing) {
                    existing.blobbyData = data;
                    return remotePost(baseUrl + '/api/settings', existing);
                })
                .then(function() {
                    _blobbySyncStatus = 'synced';
                    _blobbySyncIndicator();
                })
                .catch(function(){
                    _blobbySyncStatus = 'error';
                    _blobbySyncIndicator();
                });
        } catch {
            _blobbySyncStatus = 'error';
            _blobbySyncIndicator();
        }
    }, 2000);
}

var _blobbySyncTimer = null;
var _blobbySyncStatus = 'local'; // 'local' | 'pending' | 'synced' | 'error'

function _blobbySyncIndicator() {
    var el = document.getElementById('blobby-sync-status');
    if (!el) return;
    switch (_blobbySyncStatus) {
        case 'local': el.textContent = '⬤'; el.style.color = '#888'; el.title = t("bl.syncLocal"); break;
        case 'pending': el.textContent = '◌'; el.style.color = '#facc15'; el.title = t("bl.syncPending"); break;
        case 'synced': el.textContent = '⬤'; el.style.color = '#4ade80'; el.title = t("bl.syncSynced"); break;
        case 'error': el.textContent = '⬤'; el.style.color = '#f87171'; el.title = t("bl.syncError"); break;
    }
}

function _blobbyGetAll() {
    try {
        var cfg = JSON.parse(localStorage.getItem('AIH_config')) || {};
        return cfg.blobbyData || {};
    } catch { return {}; }
}

function _blobbySetAll(data) {
    try {
        var cfg = JSON.parse(localStorage.getItem('AIH_config')) || {};
        cfg.blobbyData = data;
        localStorage.setItem('AIH_config', JSON.stringify(cfg));
        _blobbySyncStatus = 'pending';
        _blobbySyncIndicator();
        _blobbyScheduleSync(data);
    } catch {}
}

function _blobbySave(key, data) {
    var all = _blobbyGetAll();
    all[key] = data;
    _blobbySetAll(all);
}

function _blobbyLoad(key, defaultVal) {
    var all = _blobbyGetAll();
    return all[key] !== undefined ? all[key] : defaultVal;
}

function _blobbySaveAppearance(data) { _blobbySave('appearance', data); }
function _blobbyLoadAppearance(def) { return _blobbyLoad('appearance', def); }
function _blobbySaveCharacter(text) { _blobbySave('character', text); }
function _blobbyLoadCharacter(def) { return _blobbyLoad('character', def); }
function _blobbySaveChatHistory(data) { _blobbySave('chatHistory', data); }
function _blobbyLoadChatHistory() { return _blobbyLoad('chatHistory', []); }
function _blobbySaveChatState(data) { _blobbySave('chatState', data); }
function _blobbyLoadChatState(def) { return _blobbyLoad('chatState', def); }
function _blobbySaveFps(fps) { _blobbySave('fps', fps); }
function _blobbyLoadFps(def) { return _blobbyLoad('fps', def); }
// ── Mode d'agent (étape 2) : 'read' (lecture seule, défaut) | 'active' ──
// Persisté via la même voie que les autres réglages Blobby (blobbyData).
function _blobbySaveMode(mode) { _blobbySave('blobbyMode', mode); }
function _blobbyLoadMode(def) { return _blobbyLoad('blobbyMode', def); }

// ── CSS de la barre de mode du chat (étape 3) ────────────────────────────
// Injecté une seule fois (idempotent) : pas de feuille externe à charger, le
// chat reste autonome. Les classes blobby-mode-read / blobby-mode-active
// portent la bordure colorée (bleu read / orange active).
function _blobbyEnsureChatCSS() {
    if (document.getElementById('blobby-chat-css')) return;
    var style = document.createElement('style');
    style.id = 'blobby-chat-css';
    style.textContent = [
        '.blobby-chat-modebar {',
        '  display: flex; align-items: center; gap: 8px;',
        '  padding: 5px 12px; font-size: 11px; color: #94a3b8;',
        '  background: #242428; flex-shrink: 0; user-select: none;',
        '  border-bottom: 2px solid #3b82f6;',
        '  transition: border-color .15s, background .15s;',
        '}',
        '.blobby-chat-modebar.blobby-mode-read { border-bottom-color: #3b82f6; }',
        '.blobby-chat-modebar.blobby-mode-active { border-bottom-color: #D8700D; }',
        '.blobby-chat-mode-label { font-weight: 600; letter-spacing: .02em; color: #94a3b8; }',
        '.blobby-chat-mode-select {',
        '  background: #1a1a1e; color: #e2e8f0; border: 1px solid #555;',
        '  border-radius: 6px; padding: 2px 6px; font-size: 11px;',
        '  cursor: pointer; outline: none; max-width: 150px;',
        '}',
        '.blobby-chat-mode-select:focus { border-color: var(--aih-accent, #D8700D); }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
}

// ── Skill management (Blobby's learned procedures) ──

function _blobbyGetSkills() {
    try {
        var cfg = JSON.parse(localStorage.getItem('AIH_config')) || {};
        return cfg.blobbySkills || [];
    } catch { return []; }
}

function _blobbySaveSkill(name, description, command) {
    try {
        var cfg = JSON.parse(localStorage.getItem('AIH_config')) || {};
        if (!cfg.blobbySkills) cfg.blobbySkills = [];
        // Remplacer si existe deja
        var existing = cfg.blobbySkills.findIndex(function(s) { return s.name === name; });
        var skill = { name: name, description: description, command: command, created: Date.now() };
        if (existing >= 0) cfg.blobbySkills[existing] = skill;
        else cfg.blobbySkills.push(skill);
        localStorage.setItem('AIH_config', JSON.stringify(cfg));
    } catch {}
}

function _blobbyGetSkill(name) {
    var skills = _blobbyGetSkills();
    return skills.find(function(s) { return s.name.toLowerCase() === name.toLowerCase(); });
}

function _blobbyListSkills() {
    return _blobbyGetSkills();
}

// ── Memory system (Blobby's vector memory) ──

var _blobbyMsgCounter = 0;
var _blobbyLocalMemories = []; // fallback local si backend inaccessible
var _blobbyBackendAvailable = true;

function _blobbyGetBackendUrl() {
    // Aucune URL par défaut codée en dur : renvoie "" si le serveur n'est
    // pas configuré — les appelants doivent vérifier et dégrader proprement.
    try { return JSON.parse(localStorage.getItem('AIH_config'))?.serverUrl?.replace(/\/+$/, '') || ''; }
    catch { return ''; }
}

function _blobbyGetApiKey() {
    try { return JSON.parse(localStorage.getItem('AIH_config'))?.apiKey || ''; }
    catch { return ''; }
}

// ── Barre de contexte : estimation locale + rendu honnête ────────────────
// Estimation du fil côté navigateur (~4 caractères/token). Indicative : elle
// n'a de sens QUE comparée à une vraie fenêtre de contexte ; si celle-ci est
// inconnue, la barre affiche « ? max » — jamais de repli chiffré inventé.
function _blobbyEstimateTokens(container) {
    if (!container) return 0;
    var totalChars = 0;
    container.querySelectorAll('.blobby-msg').forEach(function(el) {
        totalChars += (el.textContent || '').length;
    });
    return Math.round(totalChars / 4);
}

// Met à jour la barre à partir de dataset.maxCtx / dataset.ctxSource (valeur et
// source réelles, alimentées par GET /api/presets ou llm-process).
function _blobbyUpdateContextBar(container, ctxBar) {
    if (!ctxBar) return;
    var info = formatContextBar(
        _blobbyEstimateTokens(container),
        ctxBar.dataset.maxCtx,
        ctxBar.dataset.ctxSource
    );
    applyContextBar(ctxBar, info, t);
}

async function _blobbySearchMemories(query, limit) {
    limit = limit || 5;
    var url = _blobbyGetBackendUrl() + '/api/blobby/memory/search?q=' + encodeURIComponent(query) + '&limit=' + limit;
    try {
        // Timeout historique 3000 ms → opts.timeout de la brique (même valeur).
        var data = await remoteGet(url, { timeout: 3000 });
        _blobbyBackendAvailable = true;
        return data.results || [];
    } catch(e) {
        _blobbyBackendAvailable = false;
        return _blobbyLocalSearch(query, limit);
    }
}

function _blobbyLocalSearch(query, limit) {
    // Fallback : recherche par mots-clés dans localStorage
    var q = query.toLowerCase();
    var words = q.split(/\s+/).filter(function(w) { return w.length > 2; });
    var scored = _blobbyLocalMemories.map(function(m) {
        var content = (m.content || '').toLowerCase();
        var score = 0;
        words.forEach(function(w) { if (content.indexOf(w) >= 0) score += 1; });
        return { id: m.id || 0, type: m.type || 'episode', content: m.content, importance: m.importance || 3, created_at: m.created_at || '', score: score };
    });
    scored.sort(function(a, b) { return b.score - a.score; });
    return scored.slice(0, limit).filter(function(s) { return s.score > 0; });
}

async function _blobbySaveMemory(content, memType, importance) {
    memType = memType || 'episode';
    importance = importance || 3;
    // Local backup
    _blobbyLocalMemories.push({ content: content, type: memType, importance: importance, created_at: new Date().toISOString() });
    if (_blobbyLocalMemories.length > 50) _blobbyLocalMemories = _blobbyLocalMemories.slice(-50);
    try { localStorage.setItem('blobbyLocalMemories', JSON.stringify(_blobbyLocalMemories)); } catch {}
    // Backend save (fire-and-forget)
    if (!_blobbyBackendAvailable) return;
    var url = _blobbyGetBackendUrl() + '/api/blobby/memory';
    try {
        await remotePost(url, { content: content, type: memType, importance: importance });
    } catch(e) { /* silent fail */ }
}

async function _blobbyForgetAll() {
    // Local
    _blobbyLocalMemories = [];
    try { localStorage.removeItem('blobbyLocalMemories'); } catch {}
    // Backend
    var url = _blobbyGetBackendUrl() + '/api/blobby/memory/forget';
    try { await remotePost(url, {}); } catch {}
}

// Charger les souvenirs locaux au démarrage
try { _blobbyLocalMemories = JSON.parse(localStorage.getItem('blobbyLocalMemories')) || []; } catch {}






// ── Minimal Markdown parser for Blobby chat ─────────────────────
function _blobbyMarkdownToHtml(md) {
    if (!md) return '';
    // Escape HTML first to prevent injection
    var s = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Code blocks (```...```)
    s = s.replace(/```[\w]*\n([\s\S]*?)```/g, function(m, code) {
        return '<pre style="background:#111;padding:8px;border-radius:6px;overflow-x:auto;font-size:11px;border:1px solid #333;margin:4px 0;"><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });
    // Inline code (`code`)
    s = s.replace(/`([^`\n]+)`/g, '<code style="background:#111;padding:1px 4px;border-radius:3px;font-size:11px;">$1</code>');
    // Bold (**text**)
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic (*text* — but not ** ** which are already processed)
    // Avoid lookbehind (not supported in all browsers)
    s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?![*])/g, '$1<em>$2</em>');
    // Headings (### text, ## text, # text)
    s = s.replace(/^###\s+(.+)$/gm, '<h4 style="margin:6px 0 2px;font-size:13px;color:#FF8F00;">$1</h4>');
    s = s.replace(/^##\s+(.+)$/gm, '<h3 style="margin:8px 0 3px;font-size:14px;color:#FF8F00;">$1</h3>');
    s = s.replace(/^#\s+(.+)$/gm, '<h3 style="margin:8px 0 3px;font-size:15px;color:#FF8F00;">$1</h3>');
    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--aih-accent, #D8700D);text-decoration:underline;">$1</a>');
    // Unordered lists (- text or * text)
    s = s.replace(/(?:^|\n)[-\*]\s+(.+)/g, function(m, line) {
        return '\n<li style="margin-left:16px;list-style:disc;">' + line + '</li>';
    });
    // Ordered lists (1. text)
    s = s.replace(/(?:^|\n)\d+\.\s+(.+)/g, function(m, line) {
        return '\n<li style="margin-left:16px;list-style:decimal;">' + line + '</li>';
    });
    // Wrap consecutive <li> in <ul>
    s = s.replace(/(<li[^>]*>.*?<\/li>(?:\n<li[^>]*>.*?<\/li>)*)/gs, function(m) {
        return '<ul style="margin:4px 0;padding:0;">' + m.replace(/\n/g, '') + '</ul>';
    });
    // Tables (| col | col |\n| --- | --- |\n| cell | cell |)
    s = s.replace(/((?:^|\n)\|[^\n]+\|(?:\n\|[^\n]+\|)+)/g, function(m, tableText) {
        var rows = tableText.trim().split('\n');
        if (rows.length < 2) return m;
        // Check if row 1 is the separator (| --- | --- |)
        var isSep = /^\|\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?$/.test(rows[1].trim());
        if (!isSep) return m;  // Not a table, leave as-is
        var html = '<table style="border-collapse:collapse;width:100%;font-size:11px;margin:6px 0;">';
        // Header row
        var headers = rows[0].split('|').map(function(c){return c.trim();}).filter(function(c){return c!=='';});
        html += '<thead><tr>';
        headers.forEach(function(h) {
            html += '<th style="border:1px solid #444;padding:4px 8px;background:#2a2a2e;color:#FF8F00;text-align:left;">' + h + '</th>';
        });
        html += '</tr></thead><tbody>';
        // Data rows (skip header and separator)
        for (var i = 2; i < rows.length; i++) {
            var cells = rows[i].split('|').map(function(c){return c.trim();}).filter(function(c){return c!=='';});
            html += '<tr>';
            cells.forEach(function(c) {
                html += '<td style="border:1px solid #444;padding:4px 8px;">' + c + '</td>';
            });
            html += '</tr>';
        }
        html += '</tbody></table>';
        return html;
    });
    // Line breaks (preserve newlines as br outside of pre blocks)
    s = s.replace(/(<pre[\s\S]*?<\/pre>)|\n/g, function(m, pre) {
        return pre || '<br>';
    });
    return s;
}

// ── Populate Blobby tab in AIH settings modal ──

function _blobbyPopulateSettings() {
    var container = document.getElementById('blobby-settings-container');
    if (!container || container.children.length > 0) return; // Already populated

    var _self = window.Blobby || Blobby;
    container.innerHTML = '';

    // FPS slider
    var fpsDiv = document.createElement('div');
    fpsDiv.innerHTML = '<label class="text-xs text-slate-500 dark:text-slate-400">' + t("bl.fpsAnim") + '</label>';
    var fpsSlider = document.createElement('input');
    fpsSlider.type = 'range';
    fpsSlider.min = 0; fpsSlider.max = 165; fpsSlider.value = _blobbyLoadFps(0);
    fpsSlider.className = 'w-full';
    Object.assign(fpsSlider.style, { accentColor: '#FF8F00' });
    var fpsVal = document.createElement('span');
    fpsVal.textContent = fpsSlider.value;
    fpsVal.className = 'text-xs text-slate-400 ml-2';
    fpsSlider.oninput = function() {
        fpsVal.textContent = this.value;
        _blobbySaveFps(parseInt(this.value));
        if (typeof Blobby !== 'undefined' && Blobby._loadAppearance) Blobby._loadAppearance();
    };
    fpsDiv.appendChild(fpsSlider);
    fpsDiv.appendChild(fpsVal);
    container.appendChild(fpsDiv);

    // Note
    var note = document.createElement('p');
    note.textContent = t("bl.appearanceNote");
    Object.assign(note.style, { fontSize: '11px', color: '#64748b', marginTop: '8px' });
    container.appendChild(note);

    // Status mémoire
    var memDiv = document.createElement('div');
    memDiv.style.marginTop = '12px';
    var memTitle = document.createElement('h3');
    memTitle.textContent = t("bl.memory");
    memTitle.className = 'text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2';
    memDiv.appendChild(memTitle);

    var localCount = _blobbyLocalMemories.length;
    var memInfo = document.createElement('p');
    memInfo.className = 'text-xs text-slate-500 dark:text-slate-400';
    memInfo.innerHTML = t("bl.memoryInfo", { count: localCount });
    memDiv.appendChild(memInfo);
    container.appendChild(memDiv);
}

const Blobby = {
    x: 400,
    y: 300,
    vx: 0,
    vy: 0,
    scale: 1,

    bodyParticles: [],
    _fxParticles: [],
    NUM_PARTICLES: 60,
    GRAVITY: 0.003,
    DAMPING: 0.94,
    REPULSION: 0.4,
    COHESION: 0.04,
    CUT_RADIUS: 50,

    // ── Mode d'agent (étape 2) ────────────────────────────────────────────
    // 'read' (défaut) : lecture seule — les outils de mutation/exécution ne
    // sont ni proposés au LLM (filtrage du schéma) ni exécutés (dispatcher).
    // 'active' : tout, sans confirmation humaine, avec snapshot/undo.
    // L'état vit ICI ; le SEUL changement autorisé passe par setMode()
    // (l'étape 3 branchera le dropdown sur ce point unique).
    mode: "read",
    setMode(mode) {
        // Rejet explicite des valeurs inconnues (pas de normalisation
        // silencieuse : garbage ne doit pas faire basculer actif → read).
        const m = typeof mode === "string" ? mode.trim().toLowerCase() : "";
        if (m !== "read" && m !== "active") {
            console.warn("[Blobby] setMode : mode invalide ignoré :", mode);
            return this.mode;
        }
        if (m !== this.mode) {
            Blobby.mode = m;
            _blobbySaveMode(m);
            console.log("%c🧡 Blobby mode : " + (m === "active" ? "🟠 ACTIF" : "🔵 lecture seule"), "color:#FF8F00;font-weight:bold;");
        }
        return Blobby.mode;
    },
    getMode() { return this.mode === "active" ? "active" : "read"; },
    // Consigne de mode injectée dans le prompt LLM (étape 3). Le LLM doit être
    // CONSCIENT de son mode : en Lecture seule il refuse explicitement les
    // mutations (message de refus repris mot pour mot dans bl.mode.readPrompt),
    // en Actif il sait qu'il peut agir via les outils. Source unique : getMode()
    // (jamais un état dupliqué dans l'appelant).
    _modeInstruction() {
        return this.getMode() === "active" ? t("bl.mode.activePrompt") : t("bl.mode.readPrompt");
    },
    _initMode() {
        // Persistance (défaut 'read') : valeur inconnue/corrompue → repli
        // silencieux sur 'read' via normalizeMode (défensif).
        return this.setMode(_blobbyLoadMode("read"));
    },

    mood: "happy",
    moodTimer: 0,
    mouthOpen: 0,
    targetMouthOpen: 0,

    organX: 400,
    organY: 300,
    organVx: 0,
    organVy: 0,

    mouseX: 0,
    mouseY: 0,
    mousePX: 0,
    mousePY: 0,
    mouseActive: false,

    blinkTimer: 0,
    isBlinking: false,
    blinkFrame: 0,
    BLINK_DURATION: 8,

    followMouse: false,
    isDragging: false,
    dragPrevX: 0, dragPrevY: 0,
    throwVx: 0, throwVy: 0,
    dragDistance: 0,
    time: 0,
    nodeBounceCooldown: 0,

    // ── Apparence (surchargeable via localStorage) ──
    bodyAlpha: 1.0,
    brainAlpha: 1.0,
    brainSize: 1.0,
    eyeY: 6,        // decalage Y des yeux depuis le centre
    eyeSpread: 15,   // ecartement horizontal des yeux
    eyeScale: 1.0,   // taille des yeux
    mouthY: 22,      // decalage Y de la bouche
    mouthScale: 1.0, // taille de la bouche
    colors: {         // couleurs par humeur
        happy: '#FF8F00',
        surprised: '#E65100',
        sleepy: '#43A047',
        _default: '#FF8F00'
    },

    visibleArea: null,
    _offscreen: null,
    _octx: null,

    _active: false,
    _canvas: null,
    _lastTime: 0,
    _animInterval: null,
    _origDraw: null,
    _origMD: null,
    _origMM: null,
    _origMU: null,
    _contextHandler: null,

    _loadAppearance() {
        try {
            var a = _blobbyLoadAppearance({});
            var oldParticles = this.NUM_PARTICLES;
            if (a.numParticles) this.NUM_PARTICLES = a.numParticles;
            if (a.bodyAlpha !== undefined) this.bodyAlpha = a.bodyAlpha;
            if (a.brainAlpha !== undefined) this.brainAlpha = a.brainAlpha;
            if (a.brainSize !== undefined) this.brainSize = a.brainSize;
            if (a.eyeY !== undefined) this.eyeY = a.eyeY;
            if (a.eyeSpread !== undefined) this.eyeSpread = a.eyeSpread;
            if (a.eyeScale !== undefined) this.eyeScale = a.eyeScale;
            if (a.mouthY !== undefined) this.mouthY = a.mouthY;
            if (a.mouthScale !== undefined) this.mouthScale = a.mouthScale;
            if (a.colors) {
                for (var k in a.colors) {
                    if (a.colors.hasOwnProperty(k)) this.colors[k] = a.colors[k];
                }
            }
            if (this.NUM_PARTICLES !== oldParticles) {
                this.initParticles();
            }
        } catch {}
    },

    init(canvas) {
        this._canvas = canvas;
        this.x = 400;
        this.y = 300;
        this.organX = this.x;
        this.organY = this.y;
        this.blinkTimer = 60 + Math.random() * 120;
        // Charger les settings depuis le serveur (si disponible)
        _blobbyLoadFromServer();
        this._loadAppearance();
        this.initParticles();

        this._offscreen = document.createElement('canvas');
        this._octx = this._offscreen.getContext('2d');

        this._origDraw = canvas.onDrawForeground;
        this._origMD = canvas.processMouseDown;
        this._origMM = canvas.processMouseMove;
        this._origMU = canvas.processMouseUp;

        // Handler DOM pour le clic droit, independant de Litegraph
        var _self = this;
        this._contextHandler = function(e) {
            if (!_self._active) return;
            // Convertir les coordonnées ecran → graph (inverser zoom/pan)
            var rect = canvas.canvas.getBoundingClientRect();
            var mx = (e.clientX - rect.left) / canvas.ds_scale + canvas.ds_translate[0];
            var my = (e.clientY - rect.top) / canvas.ds_scale + canvas.ds_translate[1];
            if (_self.hitTest(mx, my)) {
                e.preventDefault();
                e.stopPropagation();
                _self._openChatModal();
                _self.mood = "happy"; _self.moodTimer = 0;
                for (var i = 0; i < 3; i++) _self.addParticle(_self.x + (Math.random() - 0.5) * 20, _self.y + (Math.random() - 0.5) * 20, "sparkle");
            }
        };
        canvas.canvas.addEventListener('contextmenu', this._contextHandler);
    },

    initParticles() {
        this.bodyParticles = [];
        const count = this.NUM_PARTICLES;
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * 30;
            this.bodyParticles.push({
                x: this.x + Math.cos(angle) * r,
                y: this.y + Math.sin(angle) * r,
                vx: (Math.random() - 0.5) * 2,
                vy: (Math.random() - 0.5) * 2,
                radius: 16 + (Math.random() - 0.5) * 4
            });
        }
    },

    activate() {
        if (this._active) return;
        this._active = true;

        const canvas = this._canvas;
        if (!canvas) return;

        
        var _self = this;
        canvas.onDrawForeground = (ctx, visibleArea) => {
            if (_self._origDraw) {
                try { _self._origDraw.apply(canvas, arguments); }
                catch (e) { console.error("[Blobby] Erreur origDraw:", e); }
            }
            try {
                var now = performance.now();
                var dt = _self._lastTime ? Math.min((now - _self._lastTime) / 1000, 0.1) : (1 / 60);
                _self._lastTime = now;
                let mouseGraph = null;
                if (canvas.graph_mouse) {
                    mouseGraph = [canvas.graph_mouse[0], canvas.graph_mouse[1]];
                }
                const currentVisibleArea = canvas.visible_area || visibleArea;
                const app = window.app || window.comfyAPI?.app?.app;
                _self.update(dt, app?.graph?.nodes, mouseGraph, currentVisibleArea);
                _self.draw(ctx);
            } catch (e) {
                console.error("[Blobby] Erreur draw:", e);
            }
        };

        canvas.processMouseDown = (e) => {
            if (this._origMD) this._origMD.apply(canvas, arguments);
        };

        canvas.processMouseMove = (e) => {
            if (this._origMM) this._origMM.apply(canvas, arguments);
        };

        canvas.processMouseUp = (e) => {
            if (this._origMU) this._origMU.apply(canvas, arguments);
        };

        // Blobby vit en autonomie via setInterval (separe du rAF de ComfyUI)
        var fps = this._getFpsSetting();
        this._startAnimationInterval(fps);

        console.log("%c🧡 Blobby activé !", "font-size: 16px; color: #FF8F00; font-weight: bold;");
    },

    deactivate() {
        if (!this._active) return;
        this._active = false;

        const canvas = this._canvas;
        if (!canvas) return;

        canvas.onDrawForeground = this._origDraw || null;
        canvas.processMouseDown = this._origMD || null;
        canvas.processMouseMove = this._origMM || null;
        canvas.processMouseUp = this._origMU || null;

        // Nettoyer le handler contextmenu
        if (this._contextHandler && canvas.canvas) {
            canvas.canvas.removeEventListener('contextmenu', this._contextHandler);
            this._contextHandler = null;
        }

        // Nettoyer l'intervalle d'animation
        if (this._animInterval) {
            clearInterval(this._animInterval);
            this._animInterval = null;
        }

        if (canvas.setDirty) canvas.setDirty(true, true);
        console.log("%c🧡 Blobby désactivé.", "font-size: 14px; color: #888;");
    },

    isActive() { return this._active; },

    _getFpsSetting() {
        return _blobbyLoadFps(30);
    },

    _saveFpsSetting(fps) {
        _blobbySaveFps(fps);
    },

    _startAnimationInterval(fps) {
        if (this._animInterval) {
            clearInterval(this._animInterval);
            this._animInterval = null;
        }
        if (!fps || fps <= 0) return;
        var intervalMs = Math.round(1000 / fps);
        var canvas = this._canvas;
        var _self = this;
        this._animInterval = setInterval(function() {
            if (!_self._active) return;
            if (canvas.setDirty) canvas.setDirty(true, true);
        }, intervalMs);
    },

    _restartAnimationInterval(fps) {
        this._saveFpsSetting(fps);
        this._startAnimationInterval(fps);
    },

    _getGM(canvas) {
        return canvas.graph_mouse ? [canvas.graph_mouse[0], canvas.graph_mouse[1]] : null;
    },

    update(deltaTime, nodes, mousePosGraph, visibleArea) {
        this.time += deltaTime;
        this.moodTimer += deltaTime;
        this.visibleArea = visibleArea;

        if (this.moodTimer > 5 + Math.random() * 8) {
            const moods = ["happy", "happy", "happy", "surprised", "sleepy", "happy"];
            this.mood = moods[Math.floor(Math.random() * moods.length)];
            this.moodTimer = 0;
        }

        if (mousePosGraph) {
            this.mousePX = this.mouseX;
            this.mousePY = this.mouseY;
            this.mouseX = mousePosGraph[0];
            this.mouseY = mousePosGraph[1];
            this.mouseActive = true;
        } else {
            this.mouseActive = false;
        }

        if (visibleArea) {
            const [vx, vy, vw, vh] = visibleArea;
            const cvx = vx + vw / 2, cvy = vy + vh / 2;
            const dx = cvx - this.x, dy = cvy - this.y;
            const dist = Math.hypot(dx, dy);
            const maxDist = Math.min(vw, vh) * 0.35;
            if (dist > maxDist && dist > 0.1) {
                const pull = (dist - maxDist) / dist * 0.03;
                this.x += dx * pull;
                this.y += dy * pull;
            }
        }

        this.updateParticlePhysics();
        this.updateNodeCollision(nodes);
        this.updateOrganPosition(deltaTime);

        if (this.isDragging && mousePosGraph) {
            const dx = mousePosGraph[0] - this.x;
            const dy = mousePosGraph[1] - this.y;
            this.x = mousePosGraph[0];
            this.y = mousePosGraph[1];
            for (const p of this.bodyParticles) { p.x += dx; p.y += dy; }
            this.throwVx = dx / deltaTime;
            this.throwVy = dy / deltaTime;
            this.dragPrevX = this.x;
            this.dragPrevY = this.y;
            this.dragDistance += Math.hypot(dx, dy);
        }

        if (!this.isDragging) {
            this.x += this.vx * deltaTime * 60;
            this.y += this.vy * deltaTime * 60;
            this.vx *= Math.pow(0.995, deltaTime * 60);
            this.vy *= Math.pow(0.995, deltaTime * 60);
            if (Math.random() < 0.015 * deltaTime * 60) {
                this.vx += (Math.random() - 0.5) * 1.2 * deltaTime * 60;
                this.vy += (Math.random() - 0.5) * 1.2 * deltaTime * 60;
            }
            const speed = Math.hypot(this.vx, this.vy);
            if (speed > 5) { this.vx = (this.vx / speed) * 5; this.vy = (this.vy / speed) * 5; }
            if (this.mood === "sleepy") { this.vx *= Math.pow(0.97, deltaTime * 60); this.vy *= Math.pow(0.97, deltaTime * 60); }

            if (this.mouseActive && this.followMouse) {
                const dx = this.mouseX - this.x;
                const dy = this.mouseY - this.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 10) {
                    this.vx += (dx / dist) * 0.3 * deltaTime * 60;
                    this.vy += (dy / dist) * 0.3 * deltaTime * 60;
                }
            }
        }

        this.targetMouthOpen = this.mood === "surprised" ? 0.8 :
            this.mood === "sleepy" ? 0.1 :
                this.mood === "happy" ? 0.3 + Math.sin(this.time * 2) * 0.15 : 0.3;
        this.mouthOpen += (this.targetMouthOpen - this.mouthOpen) * 0.1 * deltaTime * 60;

        this.blinkTimer += deltaTime * 60;
        if (!this.isBlinking && this.blinkTimer > 120 + Math.random() * 180) {
            this.isBlinking = true;
            this.blinkFrame = 0;
        }
        if (this.isBlinking) {
            this.blinkFrame++;
            if (this.blinkFrame >= this.BLINK_DURATION) {
                this.isBlinking = false;
                this.blinkTimer = 0;
            }
        }

        this.updateParticles(deltaTime);
        if (this.mood === "sleepy" && Math.random() < 0.03) {
            this.addParticle(this.x - 15, this.y - 25, "zzz");
        }
    },

    updateParticlePhysics() {
        const cx = this.x, cy = this.y;
        const numP = this.bodyParticles.length;

        for (const p of this.bodyParticles) {
            const dx = cx - p.x, dy = cy - p.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 0.1) {
                const force = dist * this.GRAVITY;
                p.vx += (dx / dist) * force;
                p.vy += (dy / dist) * force;
            }
            p.vx *= this.DAMPING;
            p.vy *= this.DAMPING;
        }

        for (let i = 0; i < numP; i++) {
            const p1 = this.bodyParticles[i];
            for (let j = i + 1; j < numP; j++) {
                const p2 = this.bodyParticles[j];
                const dx = p2.x - p1.x, dy = p2.y - p1.y;
                const dist = Math.hypot(dx, dy);
                const minDist = p1.radius + p2.radius - 8;
                if (dist > 0.1) {
                    if (dist < minDist) {
                        const force = (minDist - dist) / minDist * this.REPULSION;
                        const fx = (dx / dist) * force, fy = (dy / dist) * force;
                        p1.vx -= fx; p1.vy -= fy;
                        p2.vx += fx; p2.vy += fy;
                    } else if (dist < minDist * 2.2) {
                        const force = (dist - minDist) / minDist * this.COHESION;
                        const fx = (dx / dist) * force, fy = (dy / dist) * force;
                        p1.vx += fx; p1.vy += fy;
                        p2.vx -= fx; p2.vy -= fy;
                    }
                }
            }
        }

        if (this.mouseActive) {
            const sdx = this.mouseX - this.mousePX;
            const sdy = this.mouseY - this.mousePY;
            const segLen = Math.hypot(sdx, sdy);
            if (segLen > 3) {
                const nx = -sdy / segLen, ny = sdx / segLen;
                for (const p of this.bodyParticles) {
                    let t = ((p.x - this.mousePX) * sdx + (p.y - this.mousePY) * sdy) / (segLen * segLen);
                    t = Math.max(0, Math.min(1, t));
                    const projX = this.mousePX + t * sdx, projY = this.mousePY + t * sdy;
                    const distToSeg = Math.hypot(p.x - projX, p.y - projY);
                    if (distToSeg < this.CUT_RADIUS) {
                        const cross = sdx * (p.y - this.mousePY) - sdy * (p.x - this.mousePX);
                        const side = cross >= 0 ? 1 : -1;
                        const intensity = (1 - distToSeg / this.CUT_RADIUS);
                        const push = Math.min(segLen * 0.16, 12) * intensity;
                        p.vx += nx * side * push;
                        p.vy += ny * side * push;
                    }
                }
            }
        }

        let minX = -10000, maxX = 10000, minY = -10000, maxY = 10000;
        if (this.visibleArea && this.visibleArea.length === 4) {
            const [vx, vy, vw, vh] = this.visibleArea;
            if (vw > 100 && vh > 100) { minX = vx; maxX = vx + vw; minY = vy; maxY = vy + vh; }
        }

        for (const p of this.bodyParticles) {
            if (isNaN(p.x) || isNaN(p.y) || isNaN(p.vx) || isNaN(p.vy) || !isFinite(p.x) || !isFinite(p.y)) {
                p.x = cx + (Math.random() - 0.5) * 10;
                p.y = cy + (Math.random() - 0.5) * 10;
                p.vx = 0; p.vy = 0;
                continue;
            }
            p.x += p.vx; p.y += p.vy;
            const pr = p.radius;
            if (p.x < minX + pr) { p.x = minX + pr; p.vx *= -0.5; }
            if (p.x > maxX - pr) { p.x = maxX - pr; p.vx *= -0.5; }
            if (p.y < minY + pr) { p.y = minY + pr; p.vy *= -0.5; }
            if (p.y > maxY - pr) { p.y = maxY - pr; p.vy *= -0.5; }
        }
    },

    updateNodeCollision(nodes) {
        if (!nodes) return;
        function getNodeBounds(node) {
            if (typeof node.getBounding === 'function') {
                try {
                    var bbox = node.getBounding();
                    if (bbox && bbox.length === 4) return { x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] };
                } catch {}
            }
            // Le titre de la node est dessine au-dessus de node.pos
            // On remonte le Y de la hauteur du titre pour couvrir le titre
            var titleH = window.LiteGraph?.NODE_TITLE_HEIGHT || 30;
            return { x: node.pos[0], y: node.pos[1] - titleH, w: node.size[0], h: node.size[1] + titleH };
        }

        if (!this.isDragging) {
            for (const node of nodes) {
                var b = getNodeBounds(node);
                const nx = b.x, ny = b.y, nw = b.w, nh = b.h;
                const isInside = (this.x >= nx && this.x <= nx + nw && this.y >= ny && this.y <= ny + nh);
                if (isInside) {
                    const dl = this.x - nx, dr = (nx + nw) - this.x;
                    const dt = this.y - ny, db = (ny + nh) - this.y;
                    const minDist = Math.min(dl, dr, dt, db);
                    if (minDist === dl) { this.x = nx - 30; this.vx = -1.5; }
                    else if (minDist === dr) { this.x = nx + nw + 30; this.vx = 1.5; }
                    else if (minDist === dt) { this.y = ny - 30; this.vy = -1.5; }
                    else { this.y = ny + nh + 30; this.vy = 1.5; }
                }
            }
        }

        for (const p of this.bodyParticles) {
            if (isNaN(p.x) || isNaN(p.y)) continue;
            for (const node of nodes) {
                var b = getNodeBounds(node);
                const nx = b.x, ny = b.y, nw = b.w, nh = b.h, pr = p.radius;
                const isInside = (p.x >= nx && p.x <= nx + nw && p.y >= ny && p.y <= ny + nh);
                if (isInside) {
                    const dl = p.x - nx, dr = (nx + nw) - p.x;
                    const dt = p.y - ny, db = (ny + nh) - p.y;
                    const minDist = Math.min(dl, dr, dt, db);
                    if (minDist === dl) { p.x = nx - pr; p.vx = -Math.abs(p.vx) * 0.6 - 1.5; }
                    else if (minDist === dr) { p.x = nx + nw + pr; p.vx = Math.abs(p.vx) * 0.6 + 1.5; }
                    else if (minDist === dt) { p.y = ny - pr; p.vy = -Math.abs(p.vy) * 0.6 - 1.5; }
                    else { p.y = ny + nh + pr; p.vy = Math.abs(p.vy) * 0.6 + 1.5; }
                } else {
                    const cx = Math.max(nx, Math.min(p.x, nx + nw));
                    const cy = Math.max(ny, Math.min(p.y, ny + nh));
                    const dx = p.x - cx, dy = p.y - cy;
                    const dist = Math.hypot(dx, dy);
                    if (dist < pr && dist > 0.1) {
                        const force = (pr - dist) / pr * 2.5;
                        p.x += (dx / dist) * force; p.y += (dy / dist) * force;
                        p.vx += (dx / dist) * force * 1.5; p.vy += (dy / dist) * force * 1.5;
                    }
                }
            }
        }

        if (this.nodeBounceCooldown <= 0) {
            for (const p of this.bodyParticles) {
                for (const node of nodes) {
                    var b = getNodeBounds(node);
                    const nx = b.x, ny = b.y, nw = b.w, nh = b.h;
                    if (p.x >= nx && p.x <= nx + nw && p.y >= ny && p.y <= ny + nh) {
                        if (node.comfyClass?.includes("KSampler")) {
                            this.mood = "surprised"; this.moodTimer = 0;
                        }
                        this.nodeBounceCooldown = 0.3;
                        break;
                    }
                }
            }
        }
        this.nodeBounceCooldown = Math.max(0, this.nodeBounceCooldown - 0.016);
    },

    updateOrganPosition(deltaTime) {
        let sx = 0, sy = 0, validCount = 0;
        for (const p of this.bodyParticles) {
            if (!isNaN(p.x) && !isNaN(p.y)) { sx += p.x; sy += p.y; validCount++; }
        }
        if (validCount === 0) return;
        const comX = sx / validCount, comY = sy / validCount;
        const dx = comX - this.organX, dy = comY - this.organY;
        this.organVx += dx * 0.08 * deltaTime * 60; this.organVy += dy * 0.08 * deltaTime * 60;
        this.organVx *= Math.pow(0.78, deltaTime * 60); this.organVy *= Math.pow(0.78, deltaTime * 60);
        this.organX += this.organVx; this.organY += this.organVy;
    },

    draw(ctx) {
        const zoom = Math.max(0.01, this._canvas?.ds_scale || 1);
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(1 / zoom, 1 / zoom);
        const s = this.scale || 1;
        const ox = this.organX - this.x, oy = this.organY - this.y;
        this.drawGooeyBody(ctx, s);
        this.drawBrain(ctx, ox, oy, s);
        this.drawEyes(ctx, ox, oy, s);
        this.drawMouth(ctx, ox, oy, s);
        this.drawParticles(ctx);
        ctx.restore();
    },

    drawGooeyBody(ctx, s) {
        const particles = this.bodyParticles;
        if (particles.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of particles) {
            if (isNaN(p.x) || isNaN(p.y)) continue;
            const lx = p.x - this.x, ly = p.y - this.y, r = p.radius;
            if (lx - r < minX) minX = lx - r;
            if (ly - r < minY) minY = ly - r;
            if (lx + r > maxX) maxX = lx + r;
            if (ly + r > maxY) maxY = ly + r;
        }
        const pad = 30;
        let bw = Math.ceil(maxX - minX + pad * 2);
        let bh = Math.ceil(maxY - minY + pad * 2);
        const MAX_SIZE = 800;
        if (bw > MAX_SIZE) bw = MAX_SIZE;
        if (bh > MAX_SIZE) bh = MAX_SIZE;
        if (bw < 2 || bh < 2 || !isFinite(bw) || !isFinite(bh)) {
            this.drawFallbackBody(ctx, s);
            return;
        }
        try {
            const oc = this._offscreen, octx = this._octx;
            oc.width = bw; oc.height = bh;
            octx.clearRect(0, 0, bw, bh);
            for (const p of particles) {
                if (isNaN(p.x) || isNaN(p.y)) continue;
                const lx = p.x - this.x - minX + pad, ly = p.y - this.y - minY + pad;
                const grad = octx.createRadialGradient(lx, ly, 0, lx, ly, p.radius);
                grad.addColorStop(0, "rgba(255,255,255,1)");
                grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
                grad.addColorStop(0.85, "rgba(255,255,255,0.3)");
                grad.addColorStop(1, "rgba(255,255,255,0)");
                octx.fillStyle = grad;
                octx.beginPath(); octx.arc(lx, ly, p.radius, 0, Math.PI * 2); octx.fill();
            }
            octx.filter = "blur(6px)";
            octx.drawImage(oc, 0, 0);
            octx.filter = "none";
            const bodyColor = this.getBodyColor();
            octx.save();
            octx.globalCompositeOperation = "source-in";
            octx.fillStyle = bodyColor;
            octx.fillRect(0, 0, bw, bh);
            octx.restore();
            ctx.globalAlpha = this.bodyAlpha;
            ctx.drawImage(oc, minX - pad, minY - pad);
            ctx.globalAlpha = 1;
        } catch (e) {
            this.drawFallbackBody(ctx, s);
        }
    },

    drawFallbackBody(ctx, s) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, 32 * s, 0, Math.PI * 2);
        ctx.fillStyle = this.getBodyColor();
        ctx.globalAlpha = 0.6;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.15)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
    },

    getBodyColor() {
        return this.colors[this.mood] || this.colors._default;
    },

    drawBrain(ctx, ox, oy, s) {
        ctx.save();
        ctx.globalAlpha = this.brainAlpha;
        const pulse = 1 + Math.sin(this.time * 4) * 0.03;
        ctx.translate(ox, oy - 18 * s);
        ctx.scale(pulse, pulse);
        ctx.scale(this.brainSize, this.brainSize);
        ctx.fillStyle = "#ff4da6";
        ctx.beginPath();
        ctx.arc(-7 * s, -4 * s, 10 * s, 0, Math.PI * 2);
        ctx.arc(-3 * s, -11 * s, 8 * s, 0, Math.PI * 2);
        ctx.arc(-8 * s, 4 * s, 7 * s, 0, Math.PI * 2);
        ctx.arc(7 * s, -4 * s, 10 * s, 0, Math.PI * 2);
        ctx.arc(3 * s, -11 * s, 8 * s, 0, Math.PI * 2);
        ctx.arc(8 * s, 4 * s, 7 * s, 0, Math.PI * 2);
        ctx.arc(0, 6 * s, 6 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#9d004b";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, -18 * s); ctx.lineTo(0, 6 * s);
        ctx.arc(-5 * s, -5 * s, 4 * s, Math.PI, Math.PI * 2.5);
        ctx.moveTo(-9 * s, 3 * s); ctx.quadraticCurveTo(-5 * s, 5 * s, -1 * s, 2 * s);
        ctx.arc(5 * s, -5 * s, 4 * s, 0, Math.PI * 1.5);
        ctx.moveTo(9 * s, 3 * s); ctx.quadraticCurveTo(5 * s, 5 * s, 1 * s, 2 * s);
        ctx.stroke();
        ctx.restore();
    },

    drawEyes(ctx, ox, oy, s) {
        var es = this.eyeScale;
        var eY = this.eyeY;
        var eSpr = this.eyeSpread;
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 2.5 * es;
        ctx.lineCap = "round";
        // Les sourcils suivent la position des yeux (eyeY)
        const leftEyeX = ox - eSpr * s * es, rightEyeX = ox + eSpr * s * es;
        var eyeCenterY = oy + eY * s * es;
        var browY = eyeCenterY - 12 * s * es;  // toujours 12px au-dessus de l'oeil
        ctx.beginPath();
        if (this.mood === "surprised") {
            ctx.moveTo(leftEyeX - 8 * s * es, browY - 3 * s * es);
            ctx.quadraticCurveTo(leftEyeX, browY - 8 * s * es, leftEyeX + 6 * s * es, browY - 5 * s * es);
            ctx.moveTo(rightEyeX + 8 * s * es, browY - 3 * s * es);
            ctx.quadraticCurveTo(rightEyeX, browY - 8 * s * es, rightEyeX - 6 * s * es, browY - 5 * s * es);
        } else if (this.mood === "sleepy") {
            ctx.moveTo(leftEyeX - 7 * s * es, browY + 2 * s * es); ctx.lineTo(leftEyeX + 7 * s * es, browY + 2 * s * es);
            ctx.moveTo(rightEyeX - 7 * s * es, browY + 2 * s * es); ctx.lineTo(rightEyeX + 7 * s * es, browY + 2 * s * es);
        } else {
            ctx.arc(leftEyeX, browY + 2 * s * es, 7 * s * es, Math.PI * 1.15, Math.PI * 1.85);
            ctx.moveTo(rightEyeX - 7 * s * es, browY + 2 * s * es);
            ctx.arc(rightEyeX, browY + 2 * s * es, 7 * s * es, Math.PI * 1.15, Math.PI * 1.85);
        }
        ctx.stroke();

        const drawOneEye = (ex) => {
            const eyeX = ox + ex, eyeY = oy + eY * s * es;
            const angle = Math.atan2(this.mouseY - (this.y + eyeY), this.mouseX - (this.x + eyeX));
            const lookDist = Math.min(5 * s * es, Math.hypot(this.mouseX - (this.x + eyeX), this.mouseY - (this.y + eyeY)) * 0.02);
            const pupilX = eyeX + Math.cos(angle) * lookDist;
            const pupilY = eyeY + Math.sin(angle) * lookDist;
            if (this.isBlinking) {
                ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(eyeX - 9 * s * es, eyeY); ctx.quadraticCurveTo(eyeX, eyeY + 3 * s * es, eyeX + 9 * s * es, eyeY); ctx.stroke();
                return;
            }
            const scleraR = (this.mood === "surprised" ? 11 : 9) * s * es;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath(); ctx.arc(eyeX, eyeY, scleraR, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 1; ctx.stroke();
            const pupilR = (this.mood === "surprised" ? 3 : 4.5) * s * es;
            ctx.fillStyle = "#0f172a";
            ctx.beginPath(); ctx.arc(pupilX, pupilY, pupilR, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.beginPath(); ctx.arc(pupilX - pupilR * 0.3, pupilY - pupilR * 0.3, pupilR * 0.35, 0, Math.PI * 2); ctx.fill();
        };
        drawOneEye(-eSpr * s * es); drawOneEye(eSpr * s * es);
    },

    drawMouth(ctx, ox, oy, s) {
        var mY = this.mouthY;
        var mS = this.mouthScale;
        const mouthY = oy + mY * s * mS, mouthW = (10 + this.mouthOpen * 6) * s * mS;
        if (this.mood === "surprised" && this.mouthOpen > 0.3) {
            ctx.beginPath(); ctx.ellipse(ox, mouthY, 6 * s * mS, (3 + this.mouthOpen * 6) * s * mS, 0, 0, Math.PI * 2);
            ctx.fillStyle = "#5D4037"; ctx.fill();
            ctx.beginPath(); ctx.ellipse(ox, mouthY + s * mS, 4 * s * mS, (1 + this.mouthOpen * 4) * s * mS, 0, 0, Math.PI * 2);
            ctx.fillStyle = "#D32F2F"; ctx.fill();
        } else if (this.mood === "sleepy") {
            ctx.beginPath(); ctx.ellipse(ox, mouthY, 2 * s * mS, 1.5 * s * mS, 0, 0, Math.PI * 2);
            ctx.fillStyle = "#5D4037"; ctx.fill();
        } else {
            ctx.beginPath(); ctx.arc(ox, mouthY - 2 * s, mouthW, 0.1, Math.PI - 0.1);
            ctx.strokeStyle = "#5D4037"; ctx.lineWidth = 2 * s; ctx.lineCap = "round"; ctx.stroke();
        }
    },

    addParticle(x, y, type) {
        this._fxParticles = this._fxParticles || [];
        this._fxParticles.push({
            x, y, vx: (Math.random() - 0.5) * 0.5, vy: -0.3 - Math.random() * 0.5,
            life: 1, decay: 0.008 + Math.random() * 0.005, size: 3 + Math.random() * 4,
            type: type || "bubble", hue: 30 + Math.random() * 20
        });
    },

    updateParticles(dt) {
        const arr = this._fxParticles || [];
        for (let i = arr.length - 1; i >= 0; i--) {
            const p = arr[i];
            p.x += p.vx; p.y += p.vy;
            p.life -= p.decay;
            if (p.life <= 0) arr.splice(i, 1);
        }
    },

    drawParticles(ctx) {
        const arr = this._fxParticles || [];
        for (const p of arr) {
            const lx = p.x - this.x, ly = p.y - this.y;
            if (p.type === "zzz") {
                ctx.save();
                ctx.font = `${12 + (1 - p.life) * 8}px serif`;
                ctx.fillStyle = `rgba(100, 200, 100, ${p.life * 0.6})`;
                ctx.fillText("z", lx, ly);
                ctx.restore();
            } else {
                ctx.beginPath(); ctx.arc(lx, ly, p.size * p.life, 0, Math.PI * 2);
                ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.life * 0.5})`;
                ctx.fill();
            }
        }
    },

    hitTest(mx, my) {
        for (const p of this.bodyParticles) {
            const dx = mx - p.x, dy = my - p.y;
            if (dx * dx + dy * dy < (p.radius * 2.5) ** 2) return true;
        }
        return false;
    },

    onMouseDown(pos) {
        if (this.hitTest(pos[0], pos[1])) {
            this._openChatModal();
            this.mood = "happy"; this.moodTimer = 0;
            for (let i = 0; i < 3; i++) this.addParticle(this.x + (Math.random() - 0.5) * 20, this.y + (Math.random() - 0.5) * 20, "sparkle");
            return true;
        }
        return false;
    },

    onMouseMove(pos) {},

    onMouseUp() {},

// ─── Chat modal ────────────────────────────────────────────────

    _openChatSettings() {
        // Ouvrir la modale AIH et switcher sur l'onglet Blobby
        var aihModal = document.getElementById('modal-user-settings');
        if (aihModal) {
            aihModal.classList.remove('hidden');
            aihModal.classList.add('flex');
            var blobbyTab = aihModal.querySelector('[data-tab="blobby"]');
            if (blobbyTab) switchSettingsTab('blobby', blobbyTab);
            return;
        }
        // Fallback : si la modale AIH n'existe pas, on crée la notre via v2
        var existing = document.querySelector('.blobby-chat-settings');
        if (existing) { existing.style.display = 'flex'; return; }

        var _self = this;

        // Tabs
        var tabsBar = document.createElement('div');
        Object.assign(tabsBar.style, {
            display: 'flex', borderBottom: '1px solid #333', background: '#1a1a1e', flexShrink: '0',
        });

        var tabNames = ['provider', 'appearance'];
        var tabLabels = { provider: t("bl.general"), appearance: t("bl.appearance") };
        var tabContent = document.createElement('div');
        Object.assign(tabContent.style, { padding: '14px', overflowY: 'auto', flex: '1', display: 'flex', flexDirection: 'column', gap: '12px' });

        function switchTab(name) {
            tabsBar.querySelectorAll('.bcs-tab').forEach(function(b) { b.style.borderBottom = '2px solid transparent'; b.style.color = '#888'; });
            var btn = document.getElementById('bcs-tab-' + name);
            if (btn) { btn.style.borderBottom = '2px solid #FF8F00'; btn.style.color = '#fff'; }
            document.querySelectorAll('.bcs-tab-content').forEach(function(d) { d.style.display = 'none'; });
            var el = document.getElementById('bcs-content-' + name);
            if (el) el.style.display = 'flex';
        }

        tabNames.forEach(function(name) {
            var btn = document.createElement('button');
            btn.id = 'bcs-tab-' + name;
            btn.className = 'bcs-tab';
            btn.textContent = tabLabels[name];
            Object.assign(btn.style, {
                flex: '1', padding: '8px 12px', border: 'none', cursor: 'pointer',
                background: 'transparent', fontSize: '12px', transition: 'all 0.15s',
                borderBottom: '2px solid transparent', color: '#888',
            });
            btn.onclick = function() { switchTab(name); };
            tabsBar.appendChild(btn);
        });

        // ── Tab Provider ──
        var provContent = document.createElement('div');
        provContent.id = 'bcs-content-provider';
        provContent.className = 'bcs-tab-content';
        Object.assign(provContent.style, { display: 'flex', flexDirection: 'column', gap: '12px' });

        var pLabel = document.createElement('label');
        pLabel.textContent = t("bl.providerLLM");
        Object.assign(pLabel.style, { fontSize: '12px', color: '#94a3b8', fontWeight: '600' });

        var select = document.createElement('select');
        select.id = 'blobby-chat-preset';
        Object.assign(select.style, {
            width: '100%', padding: '8px 10px', borderRadius: '6px',
            border: '1px solid #555', background: '#1a1a1e', color: '#fff',
            fontSize: '12px', outline: 'none',
        });
        select.innerHTML = '<option value="">' + t("bl.loading") + '</option>';

        (async function() {
            try {
                var cfg = {};
                try { cfg = JSON.parse(localStorage.getItem('AIH_config')) || {}; } catch {}
                var baseUrl = _blobbyGetBackendUrl();
                if (!baseUrl) {
                    select.innerHTML = '<option value="">' + t("bl.serverNotConfigured") + '</option>';
                    return;
                }
                var savedPreset = cfg.blobbyPreset || '';
                var presets;
                try {
                    presets = await remoteGet(baseUrl + '/api/presets');
                } catch (err) {
                    select.innerHTML = '<option value="">' + t("bl.loadError") + '</option>';
                    return;
                }
                select.innerHTML = '<option value="">' + t("bl.providerLLMPlaceholder") + '</option>';
                presets.forEach(function(p) {
                    var opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name + (p.is_global ? ' 🌐' : '') + (p.is_client_side ? ' 🖥️' : '');
                    if (String(p.id) === String(savedPreset)) opt.selected = true;
                    select.appendChild(opt);
                });
            } catch (e) { select.innerHTML = '<option value="">' + t("bl.errorPrefix") + ' ' + (e.message || '') + '</option>'; }
        })();

        select.onchange = function() {
            try {
                var cfg = JSON.parse(localStorage.getItem('AIH_config')) || {};
                cfg.blobbyPreset = select.value;
                localStorage.setItem('AIH_config', JSON.stringify(cfg));
            } catch {}
        };

        var pNote = document.createElement('p');
        pNote.textContent = t("bl.providerNote");
        Object.assign(pNote.style, { fontSize: '11px', color: '#64748b', lineHeight: '1.4', margin: '0' });

        provContent.appendChild(pLabel);
        provContent.appendChild(select);
        provContent.appendChild(pNote);

        // ── FPS Control ──
        var fpsSeparator = document.createElement('hr');
        Object.assign(fpsSeparator.style, { border: 'none', borderTop: '1px solid #333', margin: '4px 0' });
        provContent.appendChild(fpsSeparator);

        var fpsLabel = document.createElement('label');
        fpsLabel.textContent = t("bl.animationFps");
        Object.assign(fpsLabel.style, { fontSize: '12px', color: '#94a3b8', fontWeight: '600' });

        // Lire la valeur sauvegardee
        var savedFps = 30;
        try {
            var cfg = JSON.parse(localStorage.getItem('AIH_config')) || {};
            savedFps = parseInt(cfg.blobbyFps) || 30;
        } catch {}

        var fpsContainer = document.createElement('div');
        Object.assign(fpsContainer.style, { display: 'flex', alignItems: 'center', gap: '10px' });

        var fpsRange = document.createElement('input');
        fpsRange.type = 'range';
        fpsRange.id = 'blobby-fps-range';
        Object.assign(fpsRange.style, { flex: '1', accentColor: '#FF8F00' });
        fpsRange.min = 0;
        fpsRange.max = 165;
        fpsRange.step = 5;
        fpsRange.value = savedFps;

        var fpsValue = document.createElement('span');
        fpsValue.id = 'blobby-fps-value';
        fpsValue.textContent = savedFps > 0 ? t("bl.fps", { fps: savedFps }) : t("bl.off");
        Object.assign(fpsValue.style, { fontSize: '12px', color: '#e2e8f0', minWidth: '45px', textAlign: 'right', fontWeight: '600' });

        fpsRange.oninput = function() {
            var v = parseInt(this.value) || 0;
            fpsValue.textContent = v > 0 ? t("bl.fps", { fps: v }) : t("bl.off");
            _self._saveFpsSetting(v);
            _self._restartAnimationInterval(v);
        };

        var fpsNote = document.createElement('p');
        fpsNote.textContent = t("bl.fpsNote");
        Object.assign(fpsNote.style, { fontSize: '11px', color: '#64748b', lineHeight: '1.4', margin: '0' });

        fpsContainer.appendChild(fpsRange);
        fpsContainer.appendChild(fpsValue);
        provContent.appendChild(fpsLabel);
        provContent.appendChild(fpsContainer);
        provContent.appendChild(fpsNote);

        // ── Tab Caractere ──
        // ── Tab Apparence ──
        var appContent = document.createElement('div');
        appContent.id = 'bcs-content-appearance';
        appContent.className = 'bcs-tab-content';
        Object.assign(appContent.style, { display: 'none', flexDirection: 'column', gap: '12px' });

        // Helper pour creer un slider
        function makeSlider(label, id, min, max, step, val, suffix, onChange) {
            var row = document.createElement('div');
            var lbl = document.createElement('label');
            lbl.textContent = label;
            Object.assign(lbl.style, { fontSize: '11px', color: '#94a3b8', fontWeight: '600' });
            var cont = document.createElement('div');
            Object.assign(cont.style, { display: 'flex', alignItems: 'center', gap: '8px' });
            var input = document.createElement('input');
            input.type = 'range';
            input.id = id;
            Object.assign(input.style, { flex: '1', accentColor: '#FF8F00' });
            input.min = min; input.max = max; input.step = step; input.value = val;
            var valSpan = document.createElement('span');
            valSpan.textContent = val + (suffix || '');
            Object.assign(valSpan.style, { fontSize: '11px', color: '#e2e8f0', minWidth: '35px', textAlign: 'right' });
            input.oninput = function() {
                var v = parseFloat(this.value);
                valSpan.textContent = v + (suffix || '');
                if (onChange) onChange(v);
            };
            cont.appendChild(input);
            cont.appendChild(valSpan);
            row.appendChild(lbl);
            row.appendChild(cont);
            return row;
        }

        // Helper pour creer un color picker
        function makeColorPicker(label, color, onChange) {
            var row = document.createElement('div');
            Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
            var lbl = document.createElement('span');
            lbl.textContent = label;
            Object.assign(lbl.style, { fontSize: '11px', color: '#94a3b8', flex: '1' });
            var input = document.createElement('input');
            input.type = 'color';
            input.id = 'bapp-color-' + label.replace(/[^a-z]/gi,'').toLowerCase();
            input.value = color;
            Object.assign(input.style, { width: '32px', height: '24px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' });
            input.oninput = function() { if (onChange) onChange(this.value); };
            row.appendChild(lbl);
            row.appendChild(input);
            return row;
        }

        var _saveAppearance = function() {
            try {
                var a = {};
                a.numParticles = parseInt(document.getElementById('bapp-particles')?.value) || 60;
                a.bodyAlpha = (parseFloat(document.getElementById('bapp-body-alpha')?.value) || 100) / 100;
                a.brainAlpha = (parseFloat(document.getElementById('bapp-brain-alpha')?.value) || 100) / 100;
                a.brainSize = parseFloat(document.getElementById('bapp-brain-size')?.value) || 1;
                a.eyeY = parseFloat(document.getElementById('bapp-eye-y')?.value) || 6;
                a.eyeSpread = parseFloat(document.getElementById('bapp-eye-spread')?.value) || 15;
                a.eyeScale = parseFloat(document.getElementById('bapp-eye-scale')?.value) || 1;
                a.mouthY = parseFloat(document.getElementById('bapp-mouth-y')?.value) || 22;
                a.mouthScale = parseFloat(document.getElementById('bapp-mouth-scale')?.value) || 1;
                a.colors = {};
                ['happy','surprised','sleepy','_default'].forEach(function(k) {
                    var el = document.getElementById('bapp-color-' + k);
                    if (el) a.colors[k] = el.value;
                });
                _blobbySaveAppearance(a);
                _self._loadAppearance();
            } catch {}
        };

        function _onAppChange() { _saveAppearance(); }

        // Charger valeurs actuelles
        var _app = _blobbyLoadAppearance({});

        appContent.appendChild(makeSlider(t("bl.particles"), 'bapp-particles', 10, 120, 5, _app.numParticles || 60, '', _onAppChange));

        var sep1 = document.createElement('hr');
        Object.assign(sep1.style, { border: 'none', borderTop: '1px solid #333', margin: '4px 0' });
        appContent.appendChild(sep1);

        var secLabel = document.createElement('span');
        secLabel.textContent = t("bl.transparencies");
        Object.assign(secLabel.style, { fontSize: '11px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px' });
        appContent.appendChild(secLabel);
        appContent.appendChild(makeSlider(t("bl.body"), 'bapp-body-alpha', 0, 100, 5, Math.round((_app.bodyAlpha || 1) * 100), '%', function(v) { _onAppChange(); }));
        appContent.appendChild(makeSlider(t("bl.brain"), 'bapp-brain-alpha', 0, 100, 5, Math.round((_app.brainAlpha || 1) * 100), '%', _onAppChange));

        var sep2 = document.createElement('hr');
        Object.assign(sep2.style, { border: 'none', borderTop: '1px solid #333', margin: '4px 0' });
        appContent.appendChild(sep2);

        var secLabel2 = document.createElement('span');
        secLabel2.textContent = t("bl.eyes");
        Object.assign(secLabel2.style, { fontSize: '11px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px' });
        appContent.appendChild(secLabel2);
        appContent.appendChild(makeSlider(t("bl.height"), 'bapp-eye-y', -20, 30, 1, _app.eyeY || 6, '', _onAppChange));
        appContent.appendChild(makeSlider(t("bl.spacing"), 'bapp-eye-spread', 5, 40, 1, _app.eyeSpread || 15, '', _onAppChange));
        appContent.appendChild(makeSlider(t("bl.size"), 'bapp-eye-scale', 0.2, 3, 0.1, _app.eyeScale || 1, '', _onAppChange));

        var sep3 = document.createElement('hr');
        Object.assign(sep3.style, { border: 'none', borderTop: '1px solid #333', margin: '4px 0' });
        appContent.appendChild(sep3);

        var secLabel3 = document.createElement('span');
        secLabel3.textContent = t("bl.mouth");
        Object.assign(secLabel3.style, { fontSize: '11px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px' });
        appContent.appendChild(secLabel3);
        appContent.appendChild(makeSlider(t("bl.height"), 'bapp-mouth-y', 10, 40, 1, _app.mouthY || 22, '', _onAppChange));
        appContent.appendChild(makeSlider(t("bl.size"), 'bapp-mouth-scale', 0.2, 3, 0.1, _app.mouthScale || 1, '', _onAppChange));

        var sep4 = document.createElement('hr');
        Object.assign(sep4.style, { border: 'none', borderTop: '1px solid #333', margin: '4px 0' });
        appContent.appendChild(sep4);

        var secLabel4 = document.createElement('span');
        secLabel4.textContent = t("bl.brain");
        Object.assign(secLabel4.style, { fontSize: '11px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px' });
        appContent.appendChild(secLabel4);
        appContent.appendChild(makeSlider(t("bl.size"), 'bapp-brain-size', 0.2, 3, 0.1, _app.brainSize || 1, '', _onAppChange));

        var sep5 = document.createElement('hr');
        Object.assign(sep5.style, { border: 'none', borderTop: '1px solid #333', margin: '4px 0' });
        appContent.appendChild(sep5);

        var secLabel5 = document.createElement('span');
        secLabel5.textContent = t("bl.colorsByMood");
        Object.assign(secLabel5.style, { fontSize: '11px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px' });
        appContent.appendChild(secLabel5);

        var moods = [
            { key: 'happy', label: t("bl.moodHappy") },
            { key: 'surprised', label: t("bl.moodSurprised") },
            { key: 'sleepy', label: t("bl.moodSleepy") },
            { key: '_default', label: t("bl.moodNeutral") },
        ];
        moods.forEach(function(m) {
            var curColors = _app.colors || {};
            var c = curColors[m.key] || Blobby.colors[m.key] || '#FF8F00';
            // On remplace makeColorPicker pour controler l'id
            var row = document.createElement('div');
            Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
            var lbl = document.createElement('span');
            lbl.textContent = m.label;
            Object.assign(lbl.style, { fontSize: '11px', color: '#94a3b8', flex: '1' });
            var input = document.createElement('input');
            input.type = 'color';
            input.id = 'bapp-color-' + m.key;
            input.value = c;
            Object.assign(input.style, { width: '32px', height: '24px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' });
            input.oninput = function() { _onAppChange(); };
            row.appendChild(lbl);
            row.appendChild(input);
            appContent.appendChild(row);
        });

        tabContent.appendChild(provContent);
        tabContent.appendChild(appContent);

        // ── Body wrapper pour la v2 (tabsBar + tabContent) ──
        var bodyWrapper = document.createElement('div');
        Object.assign(bodyWrapper.style, {
            display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
        });
        tabsBar.style.flexShrink = '0';
        bodyWrapper.appendChild(tabsBar);
        tabContent.style.flex = '1';
        tabContent.style.overflowY = 'auto';
        bodyWrapper.appendChild(tabContent);

        // ── Créer la modale via v2 ──
        var m = window.aihOpenModalV2({
            title: t("bl.settingsTitle"),
            content: bodyWrapper,
            width: '380px',
            minWidth: '300px',
            minHeight: '200px',
            maxWidth: '90vw',
            maxHeight: '80vh',
            className: 'blobby-chat-settings',
            resizable: false,
            draggable: true,
            closeOnEscape: true,
        });
        // Supprimer le padding par défaut du body v2 car on gère le layout nous-mêmes
        m.body.style.padding = '0';
        // Zoom de contenu via --aih-zoom-factor (posé sur le body par AIH.Dialog).
        m.body.style.zoom = 'var(--aih-zoom-factor, 1)';

        // Activer le premier onglet
        switchTab('provider');
    },

    getCharacter: function() {
        // La personnalite evolue via le systeme memoire, pas par edition manuelle
        // L'ADN de base est le point de depart, les souvenirs l'enrichissent
        return _blobbyDefaultCharacter;
    },

    _saveChatHistory() {
        var msgs = document.getElementById('blobby-chat-msgs');
        if (!msgs) return;
        var history = [];
        msgs.querySelectorAll('.blobby-msg').forEach(function(el) {
            var html = el.innerHTML;
            if (el.dataset.role === 'action') {
                // Les boutons « Annuler » ne sont vivants que pour la session
                // courante (la pile undo n'est pas persistée) : on ne stocke
                // pas leur HTML mort dans l'historique.
                html = html.replace(/<button[^>]*data-undo-btn[\s\S]*?<\/button>/g, '');
            }
            history.push({ role: el.dataset.role, text: html });
        });
        if (history.length > 50) history = history.slice(-50);
        _blobbySaveChatHistory(history);
    },

    _openChatModal() {
        // Si deja ouverte, la ramener au premier plan. Selecteur sur la classe
        // RÉELLE de la modale v2 (AIH.Dialog pose `blobby-chat-modal` sur son
        // élément racine `.aih-dialog-root`) — l'ancien `.aih-modal` (modale v1)
        // ne matchait plus en production : chaque openChat empilait une NOUVELLE
        // modale + un 2ᵉ #blobby-chat-msgs, et le 🗑 (qui cible le 1er id)
        // effaçait la mauvaise fenêtre.
        var existing = document.querySelector('.blobby-chat-modal');
        if (existing) {
            existing.querySelector('.blobby-chat-input')?.focus();
            return;
        }

        // Restaurer la position/taille/opacite sauvegardees (ancien système AIH_config)
        var savedState = {};
        try { var scfg = JSON.parse(localStorage.getItem('AIH_config')) || {}; savedState = scfg.blobbyChatState || {}; } catch {}

        // ── Migration : ancien AIH_config.blobbyChatState → store unifié ──
        // Convertit x/y (y = distance au bas du viewport) /w/h/alpha. Ne s'exécute
        // qu'une seule fois, si `aih:blobby-chat` n'existe pas encore dans
        // `aih_window_rects`. La transparence (alpha) est persistée à part.
        try {
            var unifiedStore = JSON.parse(localStorage.getItem('aih_window_rects') || '{}');
            if (!unifiedStore['aih:blobby-chat'] && (savedState.w !== undefined || savedState.x !== undefined)) {
                var mw = savedState.w || 360;
                var mh = savedState.h || 420;
                var left = (typeof savedState.x === 'number') ? savedState.x : Math.max(20, (window.innerWidth - mw) / 2);
                var top = (typeof savedState.y === 'number')
                    ? (window.innerHeight - savedState.y - mh)
                    : Math.max(20, (window.innerHeight - mh) / 3);
                saveWindowRect('aih:blobby-chat', {
                    left: Math.round(left),
                    top: Math.round(top),
                    width: Math.round(mw),
                    height: Math.round(mh),
                });
            }
        } catch {}

        // Transparence persistée à part (alpha non inclus dans le schéma rect)
        var savedAlpha = (function () {
            try {
                var a = parseInt(localStorage.getItem('aih:blobby-chat-alpha'), 10);
                if (!isNaN(a)) return a;
            } catch {}
            return (savedState.alpha || 100);
        })();


        var _self = this;

        // ── Contenu interne : mode + messages + ctx + input ──
        var bodyWrapper = document.createElement('div');
        Object.assign(bodyWrapper.style, {
            display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
        });

        // ── Barre de mode (étape 3) : 🔵 Lecture seule / 🟠 Actif ──
        // Première barre du corps, juste sous le header ; PAS de badge séparé
        // (décision utilisateur) — la barre EST l'indicateur d'état et sa
        // bordure basse change de couleur (bleu read / orange active).
        // Source d'état unique : Blobby.getMode() ; tout changement passe par
        // Blobby.setMode() (validation + persistance + enforcement).
        _blobbyEnsureChatCSS();
        var modeBar = document.createElement('div');
        modeBar.id = 'blobby-chat-modebar';
        modeBar.className = 'blobby-chat-modebar';
        var modeBarLabel = document.createElement('label');
        modeBarLabel.className = 'blobby-chat-mode-label';
        modeBarLabel.setAttribute('for', 'blobby-chat-mode-select');
        modeBarLabel.textContent = t('bl.mode.label');
        var modeSelect = document.createElement('select');
        modeSelect.id = 'blobby-chat-mode-select';
        modeSelect.className = 'blobby-chat-mode-select';
        var optReadBody = document.createElement('option');
        optReadBody.value = 'read';
        optReadBody.textContent = t('bl.mode.read'); // 🔵 Lecture seule
        var optActiveBody = document.createElement('option');
        optActiveBody.value = 'active';
        optActiveBody.textContent = t('bl.mode.active'); // 🟠 Actif
        modeSelect.appendChild(optReadBody);
        modeSelect.appendChild(optActiveBody);
        function _syncModeBar() {
            // Reflète TOUJOURS l'état réellement APPLIQUÉ (jamais l'état tenté) :
            // une valeur inconnue serait rejetée par setMode, le <select> ne
            // doit pas afficher un mode qui n'est pas actif.
            var applied = _self.getMode();
            modeSelect.value = applied;
            modeSelect.title = t('bl.mode.tooltip');
            modeBar.classList.toggle('blobby-mode-read', applied === 'read');
            modeBar.classList.toggle('blobby-mode-active', applied === 'active');
        }
        modeSelect.onchange = function(e) {
            e.stopPropagation();
            var prev = _self.getMode();
            // setMode est la SEULE fenêtre de changement : il valide et persiste.
            var applied = _self.setMode(modeSelect.value);
            _syncModeBar();
            if (applied !== prev) {
                // Le nouveau mode prend effet au prochain tour. Un tour déjà en
                // cours conserve la consigne construite à son démarrage mais
                // reste borné par l'enforcement live du dispatcher (aucune
                // mutation possible si on repasse en Lecture seule en cours de
                // route) — la boucle n'est jamais cassée, au pire les tool_calls
                // suivants sont refusés proprement.
                _self._addChatMessage(messages, 'system', t('bl.mode.switched', { mode: applied === 'active' ? t('bl.mode.active') : t('bl.mode.read') }));
            }
        };
        _syncModeBar();
        modeBar.appendChild(modeBarLabel);
        modeBar.appendChild(modeSelect);

        // Messages area
        var messages = document.createElement('div');
        messages.id = 'blobby-chat-msgs';
        Object.assign(messages.style, {
            flex: '1', overflowY: 'auto', padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: '8px',
        });

        // Restaurer l'historique
        var history = _blobbyLoadChatHistory();
        history.forEach(function(msg) {
            var div = document.createElement('div');
            div.className = 'blobby-msg';
            div.dataset.role = msg.role;
            Object.assign(div.style, {
                padding: '6px 10px', borderRadius: '8px', fontSize: '12px',
                lineHeight: '1.4', maxWidth: '85%', wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
            });
            if (msg.role === 'user') {
                div.style.background = 'var(--aih-accent, #D8700D)'; div.style.color = '#fff';
                div.style.alignSelf = 'flex-end';
                div.textContent = msg.text;
            } else if (msg.role === 'blobby') {
                div.style.background = '#2a2a2e'; div.style.color = '#e2e8f0';
                div.style.alignSelf = 'flex-start'; div.style.border = '1px solid #444';
                div.style.whiteSpace = 'normal';
                div.innerHTML = msg.text;  // deja rendu en HTML au moment du save
            } else if (msg.role === 'system') {
                div.style.background = 'transparent'; div.style.color = '#888';
                div.style.alignSelf = 'center'; div.style.fontSize = '11px';
                div.textContent = msg.text;
            } else if (msg.role === 'action') {
                div.style.background = '#1a3a1a'; div.style.color = '#86efac';
                div.style.alignSelf = 'center'; div.style.fontSize = '11px';
                div.style.border = '1px solid #166534';
                div.innerHTML = '⚡ ' + msg.text;
            }
            messages.appendChild(div);
        });

        if (messages.children.length === 0) {
            // Message de bienvenue si aucun historique
            this._addChatMessage(messages, 'blobby', t("bl.welcome"));
        }
        messages.scrollTop = messages.scrollHeight;

        // Contexte (en bas de la zone de messages)
        var ctxBar = document.createElement('div');
        ctxBar.id = 'blobby-chat-ctx';
        Object.assign(ctxBar.style, {
            padding: '3px 12px', fontSize: '10px', color: '#555',
            textAlign: 'right', borderTop: '1px solid #2a2a2e', flexShrink: '0',
            userSelect: 'none',
        });
        // Valeur + source initiales : celles du preset sélectionné (GET
        // /api/presets), sinon inconnues → « ? max ». Jamais de repli chiffré.
        ctxBar.dataset.ctxSource = 'unknown';
        function _updateCtxBar() {
            _blobbyUpdateContextBar(messages, ctxBar);
        }
        _updateCtxBar();

        // Point d'entrée pour définir une fenêtre inconnue/estimée : ouvre
        // l'onglet Provider LLM où vit le champ « Contexte (tokens) ».
        ctxBar.onclick = function() {
            if (ctxBar.dataset.ctxSource !== 'unknown' && ctxBar.dataset.ctxSource !== 'family') return;
            if (window.AIHMenu && typeof window.AIHMenu.openSettings === 'function') {
                window.AIHMenu.openSettings('aih-providers');
            } else {
                _self._openChatSettings();
            }
        };

        // Charge le contexte du preset Blobby sélectionné (best-effort) : la
        // barre reste honnête même si l'appel échoue.
        (function _initCtxFromPreset() {
            var presetId = '';
            try { presetId = JSON.parse(localStorage.getItem('AIH_config'))?.blobbyPreset || ''; } catch {}
            var baseUrl = _blobbyGetBackendUrl();
            if (!baseUrl || !presetId) return;
            remoteGet(baseUrl + '/api/presets').then(function(presets) {
                if (!document.body.contains(ctxBar)) return; // modale fermée
                var p = (presets || []).find(function(x) { return String(x.id) === String(presetId); });
                if (p) {
                    ctxBar.dataset.maxCtx = (p.context_length !== null && p.context_length !== undefined && p.context_length !== '')
                        ? String(p.context_length) : '';
                    ctxBar.dataset.ctxSource = p.context_source || 'unknown';
                }
                _updateCtxBar();
            }).catch(function() { /* valeur inconnue conservée */ });
        })();

        // Input area
        var inputArea = document.createElement('div');
        Object.assign(inputArea.style, {
            display: 'flex', gap: '6px', padding: '8px 10px',
            borderTop: '1px solid #333', background: '#2a2a2e',
        });
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'blobby-chat-input';
        Object.assign(input.style, {
            flex: '1', padding: '6px 10px', borderRadius: '6px',
            border: '1px solid #555', background: '#1a1a1e', color: '#fff',
            fontSize: '12px', outline: 'none',
        });
        input.placeholder = t("bl.inputPlaceholder");

        var sendBtn = document.createElement('button');
        sendBtn.textContent = '➤';
        Object.assign(sendBtn.style, {
            padding: '6px 12px', borderRadius: '6px', border: 'none',
            background: 'var(--aih-accent, #D8700D)', color: '#fff', cursor: 'pointer',
            fontSize: '14px', fontWeight: '600',
        });
        sendBtn.onmouseenter = () => sendBtn.style.background = 'var(--aih-accent-hover, #F08020)';
        sendBtn.onmouseleave = () => sendBtn.style.background = 'var(--aih-accent, #D8700D)';

        function sendMessage() {
            var text = input.value.trim();
            if (!text) return;
            input.value = '';
            _self._addChatMessage(messages, 'user', text);
            _self._handleChatMessage(messages, text);
        }

        input.onkeydown = (e) => { if (e.key === 'Enter') sendMessage(); };
        sendBtn.onclick = sendMessage;

        inputArea.appendChild(input);
        inputArea.appendChild(sendBtn);

        bodyWrapper.appendChild(modeBar);
        bodyWrapper.appendChild(messages);
        bodyWrapper.appendChild(ctxBar);
        bodyWrapper.appendChild(inputArea);

        // ── Créer la modale via v2 (store unifié `aih:blobby-chat`) ──
        var m = window.aihOpenModalV2({
            title: t("bl.chatTitle"),
            content: bodyWrapper,
            width: '360px',
            height: '420px',
            minWidth: '280px',
            minHeight: '200px',
            maxWidth: '90vw',
            maxHeight: '85vh',
            className: 'blobby-chat-modal',
            resizable: true,
            draggable: true,
            storageKey: 'aih:blobby-chat',
            persistSize: true,
            persistPos: true,
            closeOnEscape: false, // Le chat a son propre handling via l'input
            onClose: function() {
                _saveChatState();
            },
        });
        // Supprimer le padding du body v2 (on a notre propre padding dans les enfants)
        m.body.style.padding = '0';
        m.body.style.overflow = 'hidden';
        // Zoom de contenu : le mécanisme unifié pose --aih-zoom-factor sur le body
        // (exclut le header). La propriété CSS `zoom` reflow correctement tout le
        // contenu (même les tailles inline en px) — supporté Chromium/Firefox ≥126.
        m.body.style.zoom = 'var(--aih-zoom-factor, 1)';

        // Transparence (persistée à part, non incluse dans le schéma rect unifié)
        m.modal.style.opacity = (savedAlpha || 100) / 100;

        // SyncDot dans le titre (classe AIH.Dialog : .aih-dialog-title)
        var titleEl = m.header.querySelector('.aih-dialog-title');
        if (titleEl) {
            titleEl.innerHTML = '🧡 <b>Blobby</b>';
            titleEl.style.color = '#FF8F00';
            var syncDot = document.createElement('span');
            syncDot.id = 'blobby-sync-status';
            Object.assign(syncDot.style, { fontSize: '9px', marginLeft: '4px', cursor: 'help' });
            titleEl.appendChild(syncDot);
        }
        setTimeout(function() { _blobbySyncIndicator(); }, 100);

        // ── Header right buttons (groupe AIH.Dialog .aih-dialog-header-right) ──
        var headerRight = (m.headerRight) || m.header.querySelector('.aih-dialog-header-right');
        // Insère les boutons custom AVANT les contrôles standard (zoom −/+, ✕)
        // qui occupent déjà la fin de .aih-dialog-header-right.
        function _appendHeaderBtn(btn) {
            if (!headerRight) return;
            headerRight.insertBefore(btn, headerRight.firstChild);
        }

        // ── Barre de mode (étape 3) : le <select> vit dans le CORPS, en 1er
        // enfant sous le header (design validé) — aucun badge ni contrôle de
        // mode dans le header. Voir la construction de bodyWrapper ci-dessus.

        // Settings button
        var settingsBtn = document.createElement('button');
        settingsBtn.innerHTML = '⚙️';
        Object.assign(settingsBtn.style, { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '14px', padding: '0 4px' });
        settingsBtn.onmouseenter = () => settingsBtn.style.color = '#fff';
        settingsBtn.onmouseleave = () => settingsBtn.style.color = '#888';
        settingsBtn.onclick = (e) => { e.stopPropagation(); _self._openChatSettings(); };
        _appendHeaderBtn(settingsBtn);

        // Clear button
        var clearBtn = document.createElement('button');
        clearBtn.textContent = '🗑';
        clearBtn.title = t("bl.clearChat");
        Object.assign(clearBtn.style, { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '12px', padding: '0 4px' });
        clearBtn.onmouseenter = () => clearBtn.style.color = '#f87171';
        clearBtn.onmouseleave = () => clearBtn.style.color = '#888';
        clearBtn.onclick = function(e) {
            e.stopPropagation();
            // Cible la zone de messages de CETTE modale (fermeture sur `messages`),
            // jamais un getElementById global : avec une éventuelle modale
            // résiduelle, le 1er id du document serait le mauvais.
            if (messages) { messages.innerHTML = ''; }
            _blobbySaveChatHistory([]);
            if (typeof Blobby !== 'undefined' && Blobby._addChatMessage) {
                Blobby._addChatMessage(messages, 'blobby', t("bl.welcome"));
            }
        };
        _appendHeaderBtn(clearBtn);

        // Forget button (confirmation via v2)
        var forgetBtn = document.createElement('button');
        forgetBtn.textContent = '🧹';
        forgetBtn.title = t("bl.forgetMemory");
        Object.assign(forgetBtn.style, { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '12px', padding: '0 4px' });
        forgetBtn.onmouseenter = () => forgetBtn.style.color = '#f87171';
        forgetBtn.onmouseleave = () => forgetBtn.style.color = '#888';
        forgetBtn.onclick = async function(e) {
            e.stopPropagation();
            var confirmed = await window.aihShowConfirm(
                t("bl.forgetTitle"),
                t("bl.forgetConfirm")
            );
            if (confirmed) {
                _blobbyForgetAll();
                _blobbyMsgCounter = 0;
                _self._addChatMessage(document.getElementById('blobby-chat-msgs'), 'system', t("bl.forgotAll"));
            }
        };
        _appendHeaderBtn(forgetBtn);

        // ── Sauvegarde de la transparence (rect géré par le store unifié) ──
        function _saveChatState() {
            try {
                var alpha = parseInt((m.modal.style.opacity || 1) * 100);
                if (isNaN(alpha)) alpha = 100;
                localStorage.setItem('aih:blobby-chat-alpha', String(alpha));
            } catch {}
        }
        // ResizeObserver : sauvegarde la transparence quand l'opacité est ajustée.
        // La taille/position du chat est désormais persistée via aih_window_rects
        // (drag/resize/close de la modale v2 avec storageKey `aih:blobby-chat`).
        var ro = new ResizeObserver(_saveChatState);
        ro.observe(m.modal);

        // Focus input
        input.focus();
    },

    _addChatMessage(container, role, text, opts) {
        var self = this;
        var div = document.createElement('div');
        div.className = 'blobby-msg';
        div.dataset.role = role;
        Object.assign(div.style, {
            padding: '6px 10px', borderRadius: '8px', fontSize: '12px',
            lineHeight: '1.4', maxWidth: '85%', wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
        });
        if (role === 'user') {
            div.style.background = 'var(--aih-accent, #D8700D)';
            div.style.color = '#fff';
            div.style.alignSelf = 'flex-end';
            div.textContent = text;
        } else if (role === 'blobby') {
            div.style.background = '#2a2a2e';
            div.style.color = '#e2e8f0';
            div.style.alignSelf = 'flex-start';
            div.style.border = '1px solid #444';
            div.style.whiteSpace = 'normal';
            div.innerHTML = _blobbyMarkdownToHtml(text);
        } else if (role === 'system') {
            div.style.background = 'transparent';
            div.style.color = '#888';
            div.style.alignSelf = 'center';
            div.style.fontSize = '11px';
            div.textContent = text;
        } else if (role === 'action') {
            div.style.background = '#1a3a1a';
            div.style.color = '#86efac';
            div.style.alignSelf = 'center';
            div.style.fontSize = '11px';
            div.style.border = '1px solid #166534';
            // Valeurs du workflow interpolées dans du HTML → escapeHtml.
            div.innerHTML = '⚡ ' + escapeHtml(text);
            if (opts && opts.undoId) {
                // Ligne d'action issue d'une mutation (mode Actif) : bouton
                // « Annuler » qui restaure le snapshot d'avant l'action. La
                // pile étant runtime-only, le bouton n'est vivant que pour
                // la session courante (cf. _saveChatHistory).
                var ub = document.createElement('button');
                ub.type = 'button';
                ub.textContent = t("bl.undoAction");
                ub.title = t("bl.undoTooltip");
                ub.setAttribute('data-undo-btn', '1');
                ub.setAttribute('data-undo-id', String(opts.undoId));
                Object.assign(ub.style, {
                    marginLeft: '8px', padding: '1px 6px', fontSize: '10px',
                    borderRadius: '4px', border: '1px solid #166534',
                    background: '#0f2a0f', color: '#86efac', cursor: 'pointer',
                });
                ub.onmouseenter = () => { if (!ub.disabled) ub.style.background = '#14532d'; };
                ub.onmouseleave = () => { ub.style.background = '#0f2a0f'; };
                ub.onclick = function(ev) {
                    ev.stopPropagation();
                    self._undoChatAction(container, ub, String(opts.undoId));
                };
                div.appendChild(ub);
            }
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        this._saveChatHistory();
        // Mettre a jour la barre de contexte (valeur + source reelles, jamais inventees)
        var ctxBar = document.getElementById('blobby-chat-ctx');
        if (ctxBar) _blobbyUpdateContextBar(container, ctxBar);
    },

    async _undoChatAction(container, btn, undoId) {
        var app = window.app || window.comfyAPI?.app?.app;
        var res = await BlobbyTools.undoSnapshot(undoId, { app: app, t: t });
        if (res && res.ok) {
            this._addChatMessage(container, 'system', t("bl.undoDone", { action: (res.data && res.data.action) || '?' }));
        } else {
            this._addChatMessage(container, 'system', t("bl.undoFail", { error: (res && res.error) || '?' }));
        }
        // Après restauration, les actions postérieures deviennent incohérentes :
        // leurs boutons sont désactivés (id sorti de la pile).
        this._refreshUndoButtons(container);
    },

    _refreshUndoButtons(container) {
        if (!container || !container.querySelectorAll) return;
        var btns = container.querySelectorAll('button[data-undo-id]');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (!BlobbyTools.canUndoId(b.getAttribute('data-undo-id'))) {
                b.disabled = true;
                b.style.opacity = '0.4';
                b.title = t("bl.undoExpired");
            }
        }
    },

    // Retire l'indicateur de réflexion (messages system contenant « Blobby… »).
    // Nécessaire parce qu'en mode tool_calls les lignes d'action s'ajoutent
    // APRÈS l'indicateur : il n'est plus le dernier enfant du conteneur.
    _removeThinking(container) {
        if (!container || !container.querySelectorAll) return;
        var sys = container.querySelectorAll('.blobby-msg[data-role="system"]');
        for (var i = sys.length - 1; i >= 0; i--) {
            if ((sys[i].textContent || '').indexOf('Blobby') >= 0) { sys[i].remove(); break; }
        }
    },

    async _handleChatMessage(container, userText) {
        this._addChatMessage(container, 'system', t("bl.thinking"));

        try {
            // Construire le contexte : workflow actuel
            var workflowDesc = this._describeWorkflow();

            // Recuperer le preset LLM depuis AIH_config
            var cfg = {};
            try { cfg = JSON.parse(localStorage.getItem('AIH_config')) || {}; } catch {}
            var presetId = cfg.blobbyPreset || '';

            if (!presetId) {
                this._addChatMessage(container, 'blobby', t("bl.configureProvider"));
                return;
            }

            // ── Recherche de souvenirs pertinents ──
            var memories = [];
            try {
                memories = await _blobbySearchMemories(userText, 5);
            } catch {}
            
            // Construire le bloc mémoire
            var memoryBlock = '';
            if (memories && memories.length > 0) {
                memoryBlock = '\n\n[SOUVENIRS PERTINENTS]\n';
                memories.forEach(function(m) {
                    memoryBlock += '• ' + (m.content || '') + '\n';
                });
            }
            
            // ── Construire le prompt ──
            var character = this.getCharacter();
            var moodDesc = this.mood === 'happy' ? t("bl.moodHappyDesc")
                : this.mood === 'surprised' ? t("bl.moodSurprisedDesc")
                : this.mood === 'sleepy' ? t("bl.moodSleepyDesc")
                : t("bl.moodNeutralDesc");
            var instruction = character + memoryBlock + '\n\n'
                + 'Humeur actuelle : ' + moodDesc + '\n'
                + '(Ton \"Blobby\" doit refletter cette humeur)\n\n'
                + 'Workflow actuel :\n' + workflowDesc + '\n\n'
                + 'Instructions :\n'
                + '- Si l\'utilisateur demande une action, reponds avec la commande entre crochets.\n'
                + '- Commandes disponibles :\n'
                + '  [SHELL commande] - Execute une commande shell. Ex: [SHELL ls -la], [SHELL dir], [SHELL git status], [SHELL python --version]\n'
                + '  [SKILL_SAVE nom | description | commande] - Sauvegarde une procedure pour la reutilisee. Ex: [SKILL_SAVE check_updates | Verifier les mises a jour des nodes | cd custom_nodes && for /d %d in (*) do git -C \"%d\" fetch --quiet && git -C \"%d\" log HEAD..origin/main --oneline]\n'
                + '  [SKILL_RUN nom] - Execute une skill sauvegardee\n'
                + '  [SKILL_LIST] - Liste toutes les skills disponibles\n'
                + '  [MOVE_TO nom] - Deplace la vue vers un noeud du workflow\n'
                + '  [SET nom param valeur] - Modifie un parametre d\'un noeud\n'
                + '  [FOCUS nom] - Met en surbrillance un noeud\n'
                + 'Skills disponibles : ' + JSON.stringify(_blobbyGetSkills().map(function(s){return s.name;})) + '\n'
                + 'Tu peux utiliser le Markdown pour mettre en forme tes reponses (gras, listes, titres, code).\n'
                + 'Note : Tu as un VRAI terminal. Reflechis aux commandes a executer. Sauvegarde les procedures qui marchent comme skills. Ne fais pas que parler, agis !\n'
                + 'Environnement :\n'
                + '- OS : ' + (navigator.platform || 'inconnu') + '\n'
                + '- Shell : /bin/bash (Linux) ou cmd (Windows) — utilise des commandes simples et compatibles\n'
                + '- ComfyUI est installe dans le dossier custom_nodes/ de ComfyUI\n'
                + '- Le repo AIH Tools est dans custom_nodes/AIH_Tools/\n'
                + '- Pour les boucles, prefere des commandes simples (ex: ls, find, xargs) plutot que des scripts complexes\n'
                + '\n'
                + this._modeInstruction() + '\n\n'
                + 'Message de l\'utilisateur : ' + userText;

            // Aucune URL par défaut codée en dur : sans serveur configuré,
            // le chat affiche une invitation au lieu d'appeler une destination
            // arbitraire.
            var baseUrl = _blobbyGetBackendUrl();
            if (!baseUrl) {
                var thinkingEl = container.querySelector('div:last-child');
                if (thinkingEl && thinkingEl.textContent.indexOf('Blobby') >= 0) thinkingEl.remove();
                this._addChatMessage(container, 'blobby', t("bl.notConfigured"));
                return;
            }
            var headers = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

            // ── Étape 2 : chemin tool_calls (mode Actif + outils disponibles) ──
            // En mode Actif, Blobby reçoit les schémas d'outils (déjà filtrés
            // par le mode : getToolsForMode) et agit sur le workflow via des
            // tool_calls. En mode Lecture seule (défaut), ce chemin n'est PAS
            // emprunté : le parsing texte historique ([SHELL]/[SET…]/[MOVE_TO]…)
            // reste seul en piste (conservé inchangé ci-dessous).
            var finalReply = '';
            var toolRan = false;
            var toolFallbackText = false;
            var toolSchemas = null;
            if (this.getMode() === 'active') {
                try { toolSchemas = BlobbyTools.getToolsForMode('active'); } catch (eTool) { toolSchemas = null; }
                if (!toolSchemas || toolSchemas.length === 0) toolSchemas = null; // registre vide → repli texte
            }
            if (toolSchemas) {
                var toolRun = await this._runToolModeChat(container, {
                    baseUrl: baseUrl, presetId: presetId, userText: userText,
                    character: character, moodDesc: moodDesc, memoryBlock: memoryBlock,
                    workflowDesc: workflowDesc, tools: toolSchemas
                });
                if (toolRun.ok) {
                    finalReply = toolRun.finalReply;
                    toolRan = true;
                } else if (toolRun.fallbackToText) {
                    // Repli 4b : le fournisseur/modèle ne gère pas les tools.
                    toolFallbackText = true; // le tour continue en chemin texte
                } else {
                    var toolErr = toolRun.sendError;
                    this._removeThinking(container);
                    this._addChatMessage(container, 'blobby', t("bl.sorry", { error: (toolErr && toolErr.data && toolErr.data.error) || (toolErr && toolErr.message) || t("bl.errorStatus", { status: toolErr && toolErr.status }) }));
                    return;
                }
            }
            if (toolFallbackText) {
                // Repli 4b : avertissement clair PUIS reprise du même message via
                // le chemin texte historique — le tour n'est pas cassé.
                this._addChatMessage(container, 'system', t("bl.toolsUnsupported"));
            }

                        // ── Boucle agentic : LLM → commandes → résultats → LLM → ... ──
            // Pas de limite fixe — Blobby continue jusqu'à ce qu'il ait fini.
            // Sécurité : détection de boucle infinie (même réponse 2x de suite).
            // toolRan ⇒ le chemin tool_calls a déjà produit la réponse finale.
            var currentInstruction = instruction;
            var allCommandResults = [];
            var lastReplyHash = '__INITIAL__';
            var repeatedCount = 0;  // 0 = première occurrence, 1 = 2ème occurrence identique → break

            for (var turn = 0; !toolRan && turn < 100; turn++) {  // 100 = sécurité, jamais atteint en pratique
                // Mettre à jour l'indicateur
                var thinking = container.querySelector('div:last-child');
                if (thinking && thinking.textContent.indexOf('Blobby') >= 0) {
                    thinking.textContent = turn === 0
                        ? t("bl.thinking")
                        : t("bl.analyzing", { turn: turn });
                }

                var data;
                try {
                    data = await remotePost(baseUrl + '/api/keywords/llm-process', {
                        preset_id: parseInt(presetId),
                        instruction: currentInstruction
                    });
                } catch (e) {
                    var th = container.querySelector('div:last-child');
                    if (th && th.textContent.indexOf('Blobby') >= 0) th.remove();
                    this._addChatMessage(container, 'blobby', t("bl.sorry", { error: (e && e.data && e.data.error) || t("bl.errorStatus", { status: e.status }) }));
                    return;
                }

                // Fenêtre de contexte renvoyée par llm-process : max_context
                // (int OU null) + context_source. null ⇒ inconnu ; on ÉCRASE le
                // dataset (jamais de repli chiffré arbitraire) et on re-rend la barre.
                if (data && (data.max_context !== undefined || data.context_source !== undefined)) {
                    var ctxBar = document.getElementById('blobby-chat-ctx');
                    if (ctxBar) {
                        ctxBar.dataset.maxCtx = (data.max_context !== null && data.max_context !== undefined)
                            ? String(data.max_context) : '';
                        ctxBar.dataset.ctxSource = data.context_source || 'unknown';
                        _blobbyUpdateContextBar(container, ctxBar);
                    }
                }

                var reply = data.output || '...';

                // Détection de boucle : si le LLM répond la même chose 2x de suite, on force l'arrêt
                // repeatedCount = 0 : première occurrence jamais vue
                // repeatedCount = 1 : 2ème occurrence identique → on break
                var replyHash = reply.replace(/\[SHELL[^\]]*\]/g, '').trim();
                if (replyHash === lastReplyHash) {
                    repeatedCount++;
                    if (repeatedCount >= 1) {
                        reply = this._executeCommands(reply);
                        finalReply = reply;
                        break;
                    }
                } else {
                    repeatedCount = 0;
                }
                lastReplyHash = replyHash;

                // Verifier les [SHELL] AVANT _executeCommands
                var hasShellCommands = /\[SHELL\s+.+\]/i.test(reply);

                // Executer les commandes locales (MOVE_TO, SET, FOCUS) — [SET…]
                // passe par le dispatcher d'outils (enforcement + undo), les
                // autres restent des actions de vue sans mutation.
                reply = await this._executeCommands(reply, container);

                if (hasShellCommands) {
                    // Mettre à jour l'indicateur pendant l'exécution
                    var extCommands = (reply.match(/\[SHELL\s+.+?\]/gi) || []);
                    if (thinking && thinking.textContent.indexOf('Blobby') >= 0) {
                        thinking.textContent = t("bl.executing", { count: extCommands.length });
                    }

                    var turnResults = await this._executeShellCommandsAsync(reply);
                    allCommandResults = allCommandResults.concat(turnResults);

                    // Construire l'instruction pour le tour suivant
                    var resultsText = turnResults.map(function(r) {
                        return t("bl.commandResult", { command: r.command, output: r.output });
                    }).join('\n\n---\n\n');

                    var chatHistory = this._getRecentChatHistory(6);
                    currentInstruction = character + '\n\n'
                        + this._modeInstruction() + '\n\n'
                        + 'Historique de la conversation:\n' + chatHistory + '\n\n'
                        + 'Tu as exécuté des commandes shell. Voici les résultats:\n\n'
                        + resultsText + '\n\n'
                        + 'Analyse ces résultats et réponds à l\'utilisateur.\n'
                        + 'Si tu as besoin d\'autres commandes, utilise [SHELL commande] (tu as le droit d\'enchaîner autant de tours que nécessaire).\n'
                        + 'Sinon, donne ta réponse finale en Markdown (sans commandes [SHELL]).\n'
                        + 'Question actuelle de l\'utilisateur: ' + userText;
                    continue;
                }

                // Pas de commandes shell → c'est la réponse finale
                finalReply = reply;
                break;
            }

            if (!finalReply) {
                finalReply = t("bl.giveUp")
                    + allCommandResults.map(function(r) { return r.output; }).join('\n\n');
            }


            // Enlever le thinking (robuste : en mode tool_calls, les lignes
            // d'action passent APRÈS l'indicateur, qui n'est plus last-child).
            var thinkingEl = container.querySelector('div:last-child');
            if (thinkingEl && thinkingEl.textContent.indexOf('Blobby') >= 0) thinkingEl.remove();
            this._removeThinking(container);

            // Nettoyer les placeholders restants
            finalReply = finalReply.replace(/⏳[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim();

            // Afficher la réponse finale avec markdown
            this._addChatMessage(container, 'blobby', finalReply);

            // ── Sauvegarder le souvenir (fire-and-forget) ──
            _blobbyMsgCounter++;
            var memText = 'User: ' + userText + ' → Blobby: ' + finalReply.substring(0, 200);
            var importance = 3;
            if (finalReply.indexOf('⚠️ MEMORABLE') >= 0) importance = 5;
            _blobbySaveMemory(memText, 'episode', importance);

            // ── Mise à jour personnalité tous les 5 messages ──
            if (_blobbyMsgCounter % 5 === 0) {
                // Demander au LLM de mettre à jour la personnalité (fire-and-forget)
                var baseUrl = _blobbyGetBackendUrl();
                if (!baseUrl) return; // Serveur non configuré : skip silencieux
                var updateInstruction = 'Tu es Blobby. Voici ta personnalite actuelle et la conversation recente. '
                    + 'Mets a jour ta personnalite en gardant 80% de l\'ancienne et en ajoutant max 20% de nouveau. '
                    + 'Reste concis (max 200 caracteres). Reponds UNIQUEMENT avec la nouvelle description de personnalite.\n\n'
                    + 'Personnalite actuelle: ' + character + '\n\n'
                    + 'Derniers echanges: ' + userText.substring(0, 200);
                remotePost(baseUrl + '/api/keywords/llm-process', {
                    preset_id: parseInt(presetId),
                    instruction: updateInstruction
                }).then(function(d) {
                    if (d.output) {
                        // Sauvegarder la nouvelle personnalite
                        _blobbySaveCharacter(d.output.trim().substring(0, 300));
                        _blobbySaveMemory('Personnalite mise a jour: ' + d.output.trim().substring(0, 100), 'personality', 4);
                    }
                }).catch(function() {});
            }

        } catch (e) {
            var thinking = container.querySelector('div:last-child');
            if (thinking && thinking.textContent === t("bl.thinking")) thinking.remove();
            this._addChatMessage(container, 'system', t("bl.error") + ' ' + (e.message || ''));
        }
    },

    // ─── Étape 2 : boucle tool_calls (mode Actif) ──────────────────────────
    // Contrat backend (étape 1) : POST accepte `messages` (liste complète,
    // remplace la construction system+user), `tools` et `tool_choice` ; la
    // réponse contient `tool_calls` en forme PROVIDER VERBATIM
    // `[{id, type:'function', function:{name, arguments}}]` (arguments =
    // STRING à JSON.parse) et `output` (peut être null sur un tour d'outil
    // pur). Chaque tool_call est dispatché (enforcement + snapshot/undo dans
    // blobby_tools.js), loggé comme ligne d'action (bouton « Annuler » si
    // mutation), puis les résultats repartent en messages role:'tool'
    // (tool_call_id) pour le tour suivant, jusqu'à une réponse texte. L'écho
    // du message assistant conserve la forme provider (`type` + `function`) :
    // c'est ce que DeepSeek/OpenAI exigent au tour suivant.
    async _runToolModeChat(container, p) {
        var self = this;
        var app = window.app || window.comfyAPI?.app?.app;
        var messages = this._buildToolModeMessages(p);

        var result = await BlobbyTools.runToolLoop({
            messages: messages,
            maxTurns: 100, // même garde anti-boucle que la boucle agentic texte
            send: async function(convo) {
                var data = await remotePost(p.baseUrl + '/api/keywords/llm-process', {
                    preset_id: parseInt(p.presetId),
                    messages: convo,
                    tools: p.tools,
                    tool_choice: 'auto'
                });
                // Fenêtre de contexte renvoyée par llm-process : max_context
                // (int OU null) + context_source — même mise à jour honnête
                // de la barre que le chemin texte (jamais de repli chiffré).
                if (data && (data.max_context !== undefined || data.context_source !== undefined)) {
                    var ctxBar = document.getElementById('blobby-chat-ctx');
                    if (ctxBar) {
                        ctxBar.dataset.maxCtx = (data.max_context !== null && data.max_context !== undefined)
                            ? String(data.max_context) : '';
                        ctxBar.dataset.ctxSource = data.context_source || 'unknown';
                        _blobbyUpdateContextBar(container, ctxBar);
                    }
                }
                return data;
            },
            dispatch: function(name, args) {
                var thinking = container.querySelector('div:last-child');
                if (thinking && thinking.textContent.indexOf('Blobby') >= 0) {
                    thinking.textContent = t("bl.toolRunning", { name: name });
                }
                return BlobbyTools.dispatchToolCall(name, args, {
                    app: app,
                    mode: self.getMode(), // enforcement 2ᵉ barrière (blobby_tools)
                    t: t
                });
            },
            onToolCall: function(res, tc) {
                var labelTxt = (res && res.action) ? res.action : String(BlobbyTools.toolCallName(tc));
                var undoId = (res && res.ok && res.snapshotId) ? res.snapshotId : null;
                self._addChatMessage(container, 'action', labelTxt, { undoId: undoId });
            }
        });

        if (result.ok) {
            // La réponse finale passe AUSSI par _executeCommands : les
            // commandes locales [SET…]/[MOVE_TO]/[FOCUS] restent comprises
            // dans les deux modes ([SET…] via le dispatcher : enforcement +
            // snapshot/undo). [SHELL]/[SKILL_*] ne sont traités que par la
            // boucle texte historique (fournisseurs sans tools / read).
            var reply = result.finalReply;
            try { reply = await self._executeCommands(reply, container); } catch { /* jamais bloquant */ }
            return { ok: true, finalReply: reply, turns: result.turns };
        }

        if (result.exhausted) {
            // Garde anti-boucle atteinte : on rend ce qui est connu.
            return { ok: true, finalReply: t("bl.giveUp") + (result.lastOutput || ''), turns: result.turns };
        }

        // ── Repli 4b : détection DÉLIMITÉE au 1ᵉʳ tour ──
        // - erreur d'envoi au 1ᵉʳ tour dont le message/le payload signale un
        //   refus des tools (payload error, champ detail…) ;
        // - réponse 200 inattendue au 1ᵉʳ tour (ni tool_calls ni output).
        if (result.turns === 1
            && (result.unexpected
                || BlobbyTools.detectToolsUnsupported(result.resp, result.sendError))) {
            return { ok: false, fallbackToText: true };
        }

        if (result.sendError) {
            return { ok: false, sendError: result.sendError };
        }
        return { ok: false, sendError: new Error('tool loop: ' + JSON.stringify(result).substring(0, 200)) };
    },

    // Messages du tour initial : conversation récente (DOM) + message courant
    // enrichi (caractère, humeur, souvenirs, workflow). Le bloc d'instructions
    // [SHELL]/[SET…] du chemin texte est remplacé par la consigne d'outils —
    // les schémas voyagent dans `tools`, pas dans le texte.
    _buildToolModeMessages(p) {
        var msgs = this._getRecentChatMessages(8); // [{role:'user'|'assistant', content}]
        // Le message courant est déjà dans l'historique (ajouté au DOM avant
        // _handleChatMessage) : on le retire pour ne pas le doubler dans
        // l'instruction enrichie qui se termine par « Message de l'utilisateur ».
        if (msgs.length && msgs[msgs.length - 1].role === 'user' && msgs[msgs.length - 1].content === p.userText) {
            msgs.pop();
        }
        var instruction = p.character + (p.memoryBlock || '') + '\n\n'
            + 'Humeur actuelle : ' + p.moodDesc + '\n'
            + '(Ton "Blobby" doit refletter cette humeur)\n\n'
            + 'Workflow actuel :\n' + p.workflowDesc + '\n\n'
            + this._modeInstruction() + '\n'
            + 'Tu disposes d\'OUTILS (schémas fournis avec la requête) pour lire,\n'
            + 'modifier et exécuter le workflow ComfyUI : describe_workflow, list_nodes, get_node_by_id,\n'
            + 'get_node_widgets, get_node_widget, get_node_connections, get_object_info, get_queue_status,\n'
            + 'get_execution_status, set_widget_value, set_node_title, set_node_color, move_node, add_node,\n'
            + 'remove_node, connect_nodes, disconnect_nodes, queue_prompt, interrupt.\n'
            + '- Pour agir, ÉMETS un tool_call (ne décris pas l\'action, fais-la).\n'
            + '- Les résultats d\'outils te seront renvoyés : analyse-les, enchaîne si nécessaire, puis\n'
            + '  donne ta réponse finale en Markdown.\n'
            + '- Les commandes texte [SHELL]/[SKILL_*] ne sont traitées qu\'en mode Lecture seule ; ici,\n'
            + '  utilise les outils ([SET…]/[MOVE_TO] dans le texte restent compris, mais préfère les outils).\n'
            + 'Environnement :\n'
            + '- OS : ' + (navigator.platform || 'inconnu') + '\n'
            + '- Shell : /bin/bash (Linux) ou cmd (Windows) — utilise des commandes simples et compatibles\n'
            + '- ComfyUI est installe dans le dossier custom_nodes/ de ComfyUI\n'
            + '- Le repo AIH Tools est dans custom_nodes/AIH_Tools/\n'
            + 'Tu peux utiliser le Markdown pour mettre en forme tes reponses.\n\n'
            + 'Message de l\'utilisateur : ' + p.userText;
        msgs.push({ role: 'user', content: instruction });
        return msgs;
    },

    // Historique structuré (messages OpenAI-like) pour le contrat `messages`.
    _getRecentChatMessages(count) {
        var msgs = document.getElementById('blobby-chat-msgs');
        if (!msgs) return [];
        var out = [];
        var allMsgs = msgs.querySelectorAll('.blobby-msg');
        var start = Math.max(0, allMsgs.length - count);
        for (var i = start; i < allMsgs.length; i++) {
            var el = allMsgs[i];
            var role = el.dataset.role;
            var text = (el.textContent || '').trim();
            if (!text) continue;
            if (role === 'user') out.push({ role: 'user', content: text });
            else if (role === 'blobby') out.push({ role: 'assistant', content: text.substring(0, 300) });
            // 'system'/'action' exclus : lignes d'état, pas de la conversation.
        }
        return out;
    },

    _getRecentChatHistory(count) {
        var msgs = document.getElementById('blobby-chat-msgs');
        if (!msgs) return '';
        var history = [];
        var allMsgs = msgs.querySelectorAll('.blobby-msg');
        var start = Math.max(0, allMsgs.length - count);
        for (var i = start; i < allMsgs.length; i++) {
            var el = allMsgs[i];
            var role = el.dataset.role;
            var text = el.textContent || '';
            if (role === 'user') {
                history.push(t("bl.historyUser") + text);
            } else if (role === 'blobby') {
                history.push(t("bl.historyBlobby") + text.substring(0, 300));
            }
        }
        return history.join('\n');
    },

    _describeWorkflow() {
        var app = window.app || window.comfyAPI?.app?.app;
        if (!app || !app.graph || !app.graph.nodes) return t("bl.noWorkflow");

        var nodes = app.graph.nodes;
        var desc = t("bl.workflowDesc", { count: nodes.length });
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var title = n.title || n.comfyClass || t("bl.unknown");
            var widgets = '';
            if (n.widgets && n.widgets.length > 0) {
                widgets = ' [' + n.widgets.map(function(w) {
                    if (w.type === 'number' || w.type === 'slider') return w.name + '=' + w.value;
                    if (w.type === 'combo') return w.name + '=' + (w.value || '');
                    return w.name;
                }).join(', ') + ']';
            }
            desc += '  - ' + title + widgets + '\n';
        }
        return desc;
    },

    async _executeCommands(reply, container) {
        // Executer les commandes [MOVE_TO ...], [SET ...], [FOCUS ...]
        // ([SET…] passe par le dispatcher d'outils : enforcement du mode +
        // snapshot/undo — en Lecture seule il est refusé avec un message,
        // il ne mute jamais en douceur).
        var app = window.app || window.comfyAPI?.app?.app;
        if (!app || !app.graph || !app.graph.nodes) return reply;

        var self = this;
        var result = reply;

        // [SET nom param valeur] — extraction d'abord (replace synchrone),
        // puis exécution async et réinjection des résultats.
        var setCommands = [];
        result = result.replace(/\[SET\s+([^\]]+)\]/gi, function(match, argsStr) {
            var parts = argsStr.trim().split(/\s+/);
            if (parts.length < 3) {
                setCommands.push({ error: t("bl.setFormat") });
                return '⏳BSET' + (setCommands.length - 1) + '⏳';
            }
            setCommands.push({ nodeName: parts[0], widget: parts[1], value: parts.slice(2).join(' ') });
            return '⏳BSET' + (setCommands.length - 1) + '⏳';
        });
        for (var s = 0; s < setCommands.length; s++) {
            var c = setCommands[s];
            var rep;
            if (c.error) {
                rep = c.error;
            } else {
                var nameLc = c.nodeName.toLowerCase();
                var nodeFound = null;
                for (var i = 0; i < app.graph.nodes.length; i++) {
                    var n = app.graph.nodes[i];
                    var title = (n.title || n.comfyClass || '').toLowerCase();
                    if (title.includes(nameLc)) { nodeFound = n; break; }
                }
                if (!nodeFound) {
                    rep = t("bl.nodeNotFound", { name: c.nodeName });
                } else {
                    var resSet = await BlobbyTools.dispatchToolCall('set_widget_value',
                        { id: nodeFound.id, widget: c.widget, value: c.value },
                        { app: app, mode: self.getMode(), t: t });
                    rep = resSet.ok
                        ? (resSet.action || t("bl.done"))
                        : '⚠️ ' + (resSet.error || t("bl.error"));
                    if (resSet.ok && resSet.snapshotId && container) {
                        // Ligne d'action avec bouton « Annuler », comme le chemin tool_calls.
                        self._addChatMessage(container, 'action', resSet.action || t("bl.done"), { undoId: resSet.snapshotId });
                    }
                }
            }
            result = result.replace('⏳BSET' + s + '⏳', rep);
        }

        // [MOVE_TO nom_du_noeud]
        result = result.replace(/\[MOVE_TO\s+([^\]]+)\]/gi, (match, nodeName) => {
            var name = nodeName.trim().toLowerCase();
            for (var i = 0; i < app.graph.nodes.length; i++) {
                var n = app.graph.nodes[i];
                var title = (n.title || n.comfyClass || '').toLowerCase();
                if (title.includes(name)) {
                    app.canvas.centerOnNode(n);
                    return t("bl.viewMoved", { name: n.title || n.comfyClass });
                }
            }
            return t("bl.nodeNotFound", { name: nodeName.trim() });
        });

        // [FOCUS nom_du_noeud]
        result = result.replace(/\[FOCUS\s+([^\]]+)\]/gi, (match, nodeName) => {
            var name = nodeName.trim().toLowerCase();
            for (var i = 0; i < app.graph.nodes.length; i++) {
                var n = app.graph.nodes[i];
                var title = (n.title || n.comfyClass || '').toLowerCase();
                if (title.includes(name)) {
                    // Mettre en surbrillance en centrant + animant
                    n.color = '#FF8F00';
                    n.bgcolor = '#2a1a00';
                    app.canvas.centerOnNode(n);
                    app.graph.setDirtyCanvas(true, true);
                    setTimeout(() => {
                        n.color = undefined;
                        n.bgcolor = undefined;
                        app.graph.setDirtyCanvas(true, true);
                    }, 2000);
                    return t("bl.focusOn", { name: n.title || n.comfyClass });
                }
            }
            return t("bl.nodeNotFound", { name: nodeName.trim() });
        });

        // [SHELL], [SKILL_SAVE], [SKILL_LIST], [SKILL_RUN] sont gérés par la boucle agentic
        // Ne PAS les remplacer par des placeholders ici

        return result;
    },

    async _executeShellCommandsAsync(reply) {
        // Execute les commandes [SHELL ...] de maniere synchrone et retourne les resultats
        var localUrl = window.location.origin.replace(/\/+$/, '');
        var headers = { 'Content-Type': 'application/json' };
        var results = [];

        // Extraire toutes les commandes [SHELL ...]
        var commands = [];
        var textWithoutShell = reply.replace(/\[SHELL\s+(.+)\]/gi, function(match, cmd) {
            commands.push(cmd.trim());
            return '⏳';
        });

        // Executer chaque commande sequentiellement
        for (var i = 0; i < commands.length; i++) {
            try {
                var r = await HolafFetch.request(localUrl + '/aih/blobby/exec', {
                    method: 'POST',
                    raw: true,
                    body: { action: 'shell', command: commands[i] }
                });
                // L'exec est protégé par l'auth terminal Holaf (cookie holaf_session).
                // Un 401 doit se voir : on invite au login au lieu d'une erreur muette.
                if (r.status === 401) {
                    results.push({ command: commands[i], output: t("bl.sessionRequired") });
                    continue;
                }
                var data = await r.json().catch(() => ({}));
                var output = data.output || (data.ok ? t("bl.done") : t("bl.error"));
                results.push({ command: commands[i], output: output });
            } catch(e) {
                results.push({ command: commands[i], output: t("bl.networkError") + ' ' + e.message });
            }
        }

        // Traiter aussi [SKILL_SAVE] et [SKILL_LIST] et [SKILL_RUN]
        textWithoutShell = textWithoutShell.replace(/\[SKILL_SAVE\s+(.+)\]/gi, function(match, args) {
            var parts = args.split('|').map(function(s) { return s.trim(); });
            if (parts.length >= 3) {
                _blobbySaveSkill(parts[0], parts[1], parts.slice(2).join('|').trim());
                return t("bl.skillSaved", { name: parts[0] });
            }
            return t("bl.skillFormat");
        });

        textWithoutShell = textWithoutShell.replace(/\[SKILL_LIST\]/gi, function() {
            var skills = _blobbyListSkills();
            if (skills.length === 0) return t("bl.noSkills");
            return skills.map(function(s) { return '• ' + s.name + ': ' + s.description; }).join('\n');
        });

        textWithoutShell = textWithoutShell.replace(/\[SKILL_RUN\s+(.+)\]/gi, function(match, name) {
            var skill = _blobbyGetSkill(name.trim());
            if (!skill) return t("bl.skillNotFound", { name: name.trim() });
            // Re-executer la commande de la skill
            if (skill.command) {
                results.push({ command: skill.command, output: t("bl.skillExec", { name: name.trim() }) });
            }
            return t("bl.skillRunning", { name: name.trim() });
        });

        return results;
    },

    _executeRemoteCommands(reply, callback) {
        // Execute les commandes [SHELL ...] et [SKILL_* ...] via le serveur ComfyUI local
        var localUrl = window.location.origin.replace(/\/+$/, '');
        var headers = { 'Content-Type': 'application/json' };

        var commands = [];
        var output = reply;

        // [SHELL commande] — greedy match to last ] (commands may contain ] in bash tests like [ -d "$x" ])
        output = output.replace(/\[SHELL\s+(.+)\]/gi, function(match, cmd) {
            commands.push({ action: 'shell', command: cmd.trim() });
            return '⏳';
        });

        // [SKILL_SAVE nom | description | commande]
        // greedy match: the commande part may contain ] in bash syntax
        output = output.replace(/\[SKILL_SAVE\s+(.+)\]/gi, function(match, args) {
            var parts = args.split('|').map(function(s) { return s.trim(); });
            if (parts.length >= 3) {
                _blobbySaveSkill(parts[0], parts[1], parts.slice(2).join('|').trim());
                return t("bl.skillSaved", { name: parts[0] });
            }
            return t("bl.skillFormat");
        });

        // [SKILL_LIST]
        output = output.replace(/\[SKILL_LIST\]/gi, function() {
            var skills = _blobbyListSkills();
            if (skills.length === 0) return t("bl.noSkills");
            var lines = skills.map(function(s) {
                return '• ' + s.name + ' : ' + s.description;
            });
            return t("bl.skillsAvailable") + '\n' + lines.join('\n');
        });

        // [SKILL_RUN nom]
        output = output.replace(/\[SKILL_RUN\s+([^\]]+)\]/gi, function(match, skillName) {
            var skill = _blobbyGetSkill(skillName.trim());
            if (!skill) return t("bl.skillNotFoundList", { name: skillName.trim() });
            commands.push({ action: 'shell', command: skill.command });
            return '⏳';
        });

        if (commands.length === 0) {
            if (callback) callback(output);
            return;
        }

        // Executer les commandes sequentiellement
        var idx = 0;
        function runNext() {
            if (idx >= commands.length) {
                if (callback) callback(output);
                return;
            }
            var cmd = commands[idx];
            HolafFetch.request(localUrl + '/aih/blobby/exec', {
                method: 'POST',
                raw: true,
                body: { action: 'shell', command: cmd.command }
            })
            .then(function(r) {
                // L'exec est protégé par l'auth terminal Holaf (cookie holaf_session).
                // Un 401 doit se voir : on invite au login au lieu d'une erreur muette.
                if (r.status === 401) {
                    output = output.replace('⏳', '\n\n' + t("bl.sessionRequired"));
                    idx++;
                    runNext();
                    return null;
                }
                return r.json();
            })
            .then(function(data) {
                if (data === null) return;
                var result = '';
                if (data.ok) {
                    result = '\n\n' + (data.output || t("bl.doneExclam"));
                } else {
                    result = '\n\n❌ ' + (data.error || data.output || t("bl.error"));
                }
                output = output.replace('⏳', result.trim());
                idx++;
                runNext();
            })
            .catch(function(err) {
                output = output.replace('⏳', '\n\n' + t("bl.error") + ' ' + (err.message || ''));
                idx++;
                runNext();
            });
        }
        runNext();
    },
};

// ─── Exposition publique pour le menu AIH ───
window.BlobbyCompanion = {
    activate: () => Blobby.activate(),
    deactivate: () => Blobby.deactivate(),
    isActive: () => Blobby.isActive(),
    // Mode d'agent (étape 2) : le dropdown de l'étape 3 passera par ces
    // deux points — setMode() est la SEULE fenêtre de changement.
    setMode: (m) => Blobby.setMode(m),
    getMode: () => Blobby.getMode(),
    toggle: () => {
        const newState = !Blobby.isActive();
        if (newState) { Blobby.activate(); } else { Blobby.deactivate(); }
        const cfg = _getAIHConfig();
        cfg.blobbyActive = newState;
        _setAIHConfig(cfg);
        return newState;
    },
    openChat: () => {
        // Ouvre le chat indépendamment de l'état d'activation de Blobby
        // (découplage : le chat est accessible même quand Blobby est fermé).
        Blobby._openChatModal();
    },
    chatVisible: () => {
        var m = document.querySelector('.blobby-chat-modal');
        return m && m.style.display !== 'none';
    }
};

// Accès complet à l'objet (historiquement absent : `_self = window.Blobby || Blobby`
// retombait toujours sur le module). Sert aux tests, à l'étape 3 (dropdown de
// mode) et au diagnostic console ; la façade ci-dessus reste l'API officielle.
window.Blobby = Blobby;

// ─── Auto-init ───
(function waitForApp() {
    const app = window.app || window.comfyAPI?.app?.app;
    if (!app) { setTimeout(waitForApp, 100); return; }

    app.registerExtension({
        name: "Blobby.Companion",
        async setup() {
            const canvas = app.canvas;
            if (!canvas) { console.warn("[Blobby] Pas de canvas"); return; }
            Blobby.init(canvas);

            // Mode d'agent (étape 2) : 'read' par défaut, restauré depuis la
            // persistance via setMode() — la seule fenêtre de changement
            // (l'UI dropdown de l'étape 3 s'y branchera).
            Blobby._initMode();

            const cfg = _getAIHConfig();
            if (cfg.blobbyActive) {
                Blobby.activate();
            }

            console.log("%c🧡 Blobby Companion chargé. Menu AIH > Activer Blobby", "font-size: 13px; color: #FF8F00;");
        }
    });
})();
