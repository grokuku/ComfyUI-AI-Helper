# === Documentation ===
# Developer: Gemini (AI Assistant), under the direction of Holaf
# Date: 2025-05-23 (Refactored: YYYY-MM-DD)
#
# Purpose:
# Main entry point for 'ComfyUI-Holaf-Utilities'. Initializes submodules,
# registers API routes, and loads custom nodes.
#
# Refactor Notes:
# - Added Profiler integration (Engine, Routes, Hooks).
# - FIX: Corrected JS path in 'profiler_js_force_mime' to 'js/profiler/holaf_profiler.js'.
# === End Documentation ===

import os
import sys

# ── MIME : les conteneurs minimaux n'ont pas /etc/mime.types → les .js de
# /extensions/ sont servis en application/octet-stream et les imports
# dynamiques sont bloqués par les navigateurs (module MIME interdit).
# L'enregistrement est global au process : ça répare aussi les autres
# extensions et les fichiers core (ex: /extensions/core/clipspace.js).
import mimetypes as _holaf_mimetypes
_holaf_mimetypes.add_type("text/javascript", ".js")
_holaf_mimetypes.add_type("text/javascript", ".mjs")
_holaf_mimetypes.add_type("text/css", ".css")
_holaf_mimetypes.add_type("application/json", ".json")
_holaf_mimetypes.add_type("image/svg+xml", ".svg")
_holaf_mimetypes.add_type("image/webp", ".webp")

# Prevent Python from writing __pycache__ / .pyc files in the source tree
os.environ.setdefault('PYTHONDONTWRITEBYTECODE', '1')

# --- Legacy Data Migration (extension folder was renamed) ---
# MUST run before ANY other initialisation opens the database, the thumbnail
# cache, config.ini, the temp directories or the user data root: holaf_database
# computes its DB path at import time and holaf_utils creates/cleans temp dirs
# at import time. Late import keeps this module free of sibling dependencies.
try:
    from .holaf_migration import run_data_migration
    run_data_migration()
except Exception as _mig_err:
    print(f"🔴 [Holaf-Migration] Unexpected error during startup migration: {_mig_err}")

# --- AIH shared backend package bootstrap -----------------------------------
# The shared AIH backend lives in the 'aih/' subpackage at the root of this
# extension (SQLite mirror store, sync engine, embeddings, local source,
# credentials, unified LLM helper — ported from AI-Helper/AIH_ComfyUI).
# ComfyUI loads custom-node packs through importlib WITHOUT adding the pack
# folder to sys.path (and the per-file node loader below registers each file
# under a synthetic "<package>.nodes.<stem>" name), so plain absolute imports
# such as `from aih import store` would fail everywhere. Registering the pack
# root on sys.path once, here and early, makes the subpackage importable by
# every consumer (routes, background threads and individually-loaded node
# files) while guaranteeing a SINGLE shared module instance pack-wide.
_AIH_PACK_ROOT = os.path.dirname(os.path.abspath(__file__))
if _AIH_PACK_ROOT not in sys.path:
    sys.path.insert(0, _AIH_PACK_ROOT)

import server
import asyncio
import json
import traceback
import threading
import importlib.util
import folder_paths # ComfyUI global
from aiohttp import web
import time # For time.sleep in periodic task wrapper
import re # Added for finalize_upload_model_route for subfolder splitting

# import atexit # Option pour le futur

# --- Holaf Utilities Submodules ---
from . import holaf_database
from . import holaf_config
from . import holaf_auth
from . import holaf_utils # Also initializes its dirs and cleans up temp uploads
from . import holaf_terminal
from . import holaf_image_viewer_backend
from . import holaf_server_management

# --- Profiler Engine Import ---
try:
    from .holaf_profiler_engine import ProfilerEngine
    PROFILER_AVAILABLE = True
except ImportError as e:
    print(f"🔴 [Holaf-Init] Profiler Engine import failed: {e}")
    PROFILER_AVAILABLE = False

# --- Holaf Node Helpers (Assumed to be in ./nodes/) ---
try:
    from .nodes import holaf_model_manager as model_manager_helper
except ImportError:
    print("🔴 [Holaf-Init] 'nodes/holaf_model_manager.py' not found or incomplete. Model Manager features may fail.")
    model_manager_helper = None

try:
    from .nodes import holaf_nodes_manager as nodes_manager_helper
except ImportError:
    print("🔴 [Holaf-Init] 'nodes/holaf_nodes_manager.py' not found or incomplete. Nodes Manager features may fail.")
    nodes_manager_helper = None

# --- Global Application Configuration ---
CONFIG = {}

def reload_global_config():
    global CONFIG
    CONFIG = holaf_config.load_all_configs()

# --- Dynamic asset base for browser-served files ---
# ComfyUI serves this pack's web assets under "/extensions/<pack_folder_name>/".
# The folder name must never be hardcoded (the pack may be renamed): derive it
# from this file's own location instead. Used to build asset URLs inside the
# standalone HTML pages served below (gallery, profiler, comparer).
PACK_DIR_NAME = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_ASSET_BASE = f"/extensions/{PACK_DIR_NAME}"
_HOLAF_EXT_BASE_TOKEN = "@@HOLAF_EXT_BASE@@"

def _subst_ext_base(html: str) -> str:
    """Substitutes the extension asset base token inside an HTML template."""
    return html.replace(_HOLAF_EXT_BASE_TOKEN, EXTENSION_ASSET_BASE)

# --- CSRF Protection Middleware ---
#
# Cross-Site Request Forgery protection for mutating requests. Browser-driven
# attacks always carry an Origin (or, failing that, Referer) header that points
# to a different host. Non-browser clients (curl, scripts, ComfyUI's own local
# fetch where the header is absent) are left untouched.
#
# Reverse-proxy handling:
#   The set of allowed hosts is `request.host` (the Host header seen by this
#   backend) PLUS any comma-separated values from [Security] allowed_origins.
#   The config list covers the case where a reverse proxy rewrites the Host
#   header to an internal value while the browser still sends the external host
#   in its Origin header.
def _holaf_normalize_host(value: str) -> str | None:
    """Normalize an Origin/Referer/Host value to a lowercase host[:port]."""
    if not value:
        return None
    value = value.strip().lower()
    if '://' in value:
        value = value.split('://', 1)[1]
    # Drop path, query and fragment components.
    value = value.split('/', 1)[0].split('?', 1)[0].split('#', 1)[0]
    # Drop any userinfo component (should not be present in Origin/Referer).
    if '@' in value:
        value = value.rsplit('@', 1)[1]
    value = value.strip()
    return value or None


def _holaf_allowed_hosts(request: web.Request) -> set:
    allowed_hosts = set()

    request_host = _holaf_normalize_host(request.host)
    if request_host:
        allowed_hosts.add(request_host)

    try:
        config_parser = holaf_config.get_config_parser()
        allowed_origins_raw = config_parser.get(
            'Security', 'allowed_origins', fallback=''
        )
    except Exception:
        allowed_origins_raw = ''

    for entry in allowed_origins_raw.split(','):
        normalized = _holaf_normalize_host(entry)
        if normalized:
            allowed_hosts.add(normalized)

    return allowed_hosts


@web.middleware
async def holaf_csrf_middleware(request: web.Request, handler):
    if request.method not in ('POST', 'PUT', 'PATCH', 'DELETE'):
        return await handler(request)

    source_header = request.headers.get('Origin') or None
    if source_header is None:
        source_header = request.headers.get('Referer') or None

    # No browser-style Origin/Referer header means a non-browser client, which
    # cannot be coerced into CSRF by a third-party site.
    if source_header is None:
        return await handler(request)

    source_host = _holaf_normalize_host(source_header)
    allowed_hosts = _holaf_allowed_hosts(request)

    if source_host is None or source_host not in allowed_hosts:
        return web.json_response(
            {"error": "Cross-site request rejected."},
            status=403,
        )

    return await handler(request)

# --- Initialization ---
print("--- Initializing Holaf Utilities ---")
holaf_database.init_database()
reload_global_config() # Load initial config

# --- Initialize Profiler Engine ---
profiler_engine = None
if PROFILER_AVAILABLE:
    try:
        profiler_engine = ProfilerEngine()
        print("🔵 [Holaf-Init] Profiler Engine initialized.")
    except Exception as e:
        print(f"🔴 [Holaf-Init] Failed to instantiate Profiler Engine: {e}")

# --- MODIFICATION START: Remove SaveImage patch ---
print("🔵 [Holaf-Init] Live image updates now handled by Filesystem Watcher.")
# --- MODIFICATION END ---

# --- STANDALONE GALLERY HTML TEMPLATE ---
GALLERY_HTML = _subst_ext_base("""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Holaf Gallery</title>
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_themes.css">
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_shared_panel.css">
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_image_viewer.css">
    <style>
        /* Shim for ComfyUI variables to maintain dark theme */
        :root {
            --bg-color: #202020;
            --comfy-menu-bg: #353535;
            --comfy-input-bg: #222;
            --input-text: #ddd;
            --descrip-text: #999;
            --drag-text: #ccc;
            --error-text: #ff4444;
            --border-color: #4e4e4e;
            /* Holaf theme variables - Steel Blue dark theme */
            --holaf-accent-color: #4682B4;
            --holaf-background-primary: #1C2024;
            --holaf-background-secondary: #2A3038;
            --holaf-text-primary: #D0D8E0;
            --holaf-text-secondary: #808890;
            --holaf-border-color: #36404A;
            --holaf-button-background: #4682B4;
            --holaf-button-text: #FFFFFF;
            --holaf-input-background: #24282D;
            --holaf-tag-background: #3A4E5E;
            --holaf-tag-text: #D0D8E0;
            --holaf-family-tag-background: #304050;
            --holaf-family-tag-text: #D8E0E8;
            --holaf-header-button-bg: rgba(208, 216, 224, 0.08);
            --holaf-header-button-hover-bg: rgba(208, 216, 224, 0.15);
            --holaf-header-button-text: #A0A8B0;
            --holaf-header-button-hover-text: #D0D8E0;
            --holaf-scrollbar-thumb: #3A4E5E;
            --holaf-scrollbar-track: #2A3038;
            --holaf-success-color: #4CAF50;
            --holaf-error-color: #F44336;
            --holaf-box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
            --holaf-border-radius: 4px;
        }
        body {
            background-color: var(--bg-color);
            color: var(--holaf-text-primary);
            margin: 0;
            padding: 0;
            font-family: sans-serif;
            overflow: hidden; /* Gallery handles scroll */
        }
        /* Hide the close button in standalone mode */
        #holaf-viewer-close-btn { display: none !important; }
        
        /* Ensure modal content takes full screen */
        .holaf-modal-content {
            width: 100vw !important;
            height: 100vh !important;
            max-width: none !important;
            max-height: none !important;
            border: none !important;
            border-radius: 0 !important;
            margin: 0 !important;
        }
        .holaf-modal {
            padding: 0 !important;
            background: transparent !important;
        }
    </style>
</head>
<body>
    <!-- The script will inject the gallery UI here -->
    <script type="module">
        import { initStandaloneGallery } from '@@HOLAF_EXT_BASE@@/holaf_image_viewer.js';
        // Initialize immediately
        initStandaloneGallery();
    </script>
</body>
</html>
""")

# --- PROFILER HTML TEMPLATE ---
# We use a custom route for the JS to ensure correct MIME type.
# window.HOLAF_EXT_BASE is injected before the module runs so that the aliased
# entry (/holaf/profiler/app.js) can locate pack assets without hardcoding the
# extension folder name (see js/profiler/holaf_profiler.js).
PROFILER_HTML = _subst_ext_base("""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Holaf Profiler</title>
    <style>
        :root {
            /* Steel Blue theme for standalone profiler */
            --holaf-accent-color: #4682B4;
            --holaf-background-primary: #1C2024;
            --holaf-background-secondary: #2A3038;
            --holaf-text-primary: #D0D8E0;
            --holaf-text-secondary: #808890;
            --holaf-border-color: #36404A;
            --holaf-button-background: #4682B4;
            --holaf-button-text: #FFFFFF;
            --holaf-input-background: #181C20;
            --holaf-tag-background: #3A4E5E;
            --holaf-tag-text: #D0D8E0;
            --holaf-family-tag-background: #304050;
            --holaf-family-tag-text: #D8E0E8;
            --holaf-header-button-bg: rgba(208, 216, 224, 0.08);
            --holaf-header-button-hover-bg: rgba(208, 216, 224, 0.15);
            --holaf-header-button-text: #A0A8B0;
            --holaf-header-button-hover-text: #D0D8E0;
            --holaf-scrollbar-thumb: #3A4E5E;
            --holaf-scrollbar-track: #2A3038;
            --holaf-success-color: #4CAF50;
            --holaf-error-color: #F44336;
            --holaf-box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
            --holaf-border-radius: 4px;
        }
        body {
            background-color: var(--holaf-background-primary);
            color: var(--holaf-text-primary);
            font-family: sans-serif;
            margin: 0; padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        #holaf-profiler-root {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 20px;
        }
    </style>
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_profiler.css">
</head>
<body>
    <div id="holaf-profiler-root"></div>
    <script>window.HOLAF_EXT_BASE = "@@HOLAF_EXT_BASE@@";</script>
    <script type="module">
        // Import from our custom route to bypass MIME type issues
        import { initProfiler } from '/holaf/profiler/app.js';
        initProfiler();
    </script>
</body>
</html>
""")

# --- REMOTE COMPARER HTML TEMPLATE ---
COMPARER_HTML = _subst_ext_base("""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Holaf Remote Comparer</title>
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_themes.css">
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_shared_panel.css">
    <link rel="stylesheet" href="@@HOLAF_EXT_BASE@@/css/holaf_remote_comparer_styles.css">
    <style>
        :root {
            /* Holaf theme variables - Steel Blue dark theme */
            --holaf-accent-color: #4682B4;
            --holaf-background-primary: #1C2024;
            --holaf-background-secondary: #2A3038;
            --holaf-text-primary: #D0D8E0;
            --holaf-text-secondary: #808890;
            --holaf-border-color: #36404A;
            --holaf-button-background: #4682B4;
            --holaf-button-text: #FFFFFF;
            --holaf-input-background: #24282D;
            --holaf-tag-background: #3A4E5E;
            --holaf-tag-text: #D0D8E0;
            --holaf-family-tag-background: #304050;
            --holaf-family-tag-text: #D8E0E8;
            --holaf-header-button-bg: rgba(208, 216, 224, 0.08);
            --holaf-header-button-hover-bg: rgba(208, 216, 224, 0.15);
            --holaf-header-button-text: #A0A8B0;
            --holaf-header-button-hover-text: #D0D8E0;
            --holaf-scrollbar-thumb: #3A4E5E;
            --holaf-scrollbar-track: #2A3038;
            --holaf-success-color: #4CAF50;
            --holaf-error-color: #F44336;
            --holaf-box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
            --holaf-border-radius: 4px;
        }
        body {
            background-color: var(--holaf-background-primary);
            color: var(--holaf-text-primary);
            margin: 0;
            padding: 0;
            font-family: sans-serif;
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
    </style>
</head>
<body class="holaf-theme-steel-blue">
    <script type="module">
        import { initStandaloneComparer } from '@@HOLAF_EXT_BASE@@/holaf_remote_comparer.js';
        initStandaloneComparer();
    </script>
</body>
</html>
""")

# --- API Route Definitions ---
routes = server.PromptServer.instance.routes

# Register CSRF middleware globally. The middleware itself is defined above.
try:
    app = server.PromptServer.instance.app
    app.middlewares.append(holaf_csrf_middleware)
    print("🔵 [Holaf-Init] CSRF protection middleware registered.")
except Exception as e:
    print(f"🔴 [Holaf-Init] Failed to register CSRF protection middleware: {e}")

# --- PROFILER ROUTES & HOOKS ---
if profiler_engine:
    # 1. Routes
    @routes.post("/holaf/profiler/context")
    async def profiler_set_context(request: web.Request):
        try:
            data = await request.json()
            profiler_engine.load_workflow_context(data)
            return web.json_response({"status": "ok", "message": "Context loaded."})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/holaf/profiler/context")
    async def profiler_get_context(request: web.Request):
        try:
            nodes = profiler_engine.get_context_for_frontend()
            return web.json_response({"nodes": nodes})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/holaf/profiler/run-start")
    async def profiler_run_start(request: web.Request):
        try:
            data = await request.json()
            name = data.get("name", "Untitled Run")
            run_id = profiler_engine.start_run(name=name)
            return web.json_response({"status": "ok", "run_id": run_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/holaf/profiler/run-stop")
    async def profiler_stop_run(request: web.Request):
        try:
            # stop_run is idempotent: if the run was already auto-stopped
            # (e.g. via a terminal event in the send_sync hook), is_profiling
            # is already False and this call is a no-op.
            profiler_engine.stop_run()
            return web.json_response({"status": "ok", "message": "Profiling run stopped."})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/holaf/profiler/run/{run_id}")
    async def profiler_get_run_data(request: web.Request):
        try:
            run_id = request.match_info['run_id']
            # Access DB directly via engine as a shortcut
            steps = profiler_engine.db.get_run_steps(run_id)
            return web.json_response({"steps": steps})
        except Exception as e:
            print(f"🔴 [Profiler] Error fetching run: {e}")
            return web.json_response({"error": str(e)}, status=500)
            
    # --- NEW: Standalone Profiler View Route ---
    @routes.get("/holaf/profiler/view")
    async def profiler_view_route(request: web.Request):
        return web.Response(text=PROFILER_HTML, content_type='text/html')

    # --- NEW: Force MIME Type for JS ---
    @routes.get("/holaf/profiler/app.js")
    async def profiler_js_force_mime(request: web.Request):
        try:
            # FIX: Pointing to 'js/profiler/holaf_profiler.js'
            js_path = os.path.join(os.path.dirname(__file__), "js", "profiler", "holaf_profiler.js")
            if not os.path.exists(js_path):
                 return web.Response(status=404, text=f"JS file not found at: {js_path}")
            
            with open(js_path, "r", encoding="utf-8") as f:
                content = f.read()
            return web.Response(text=content, content_type='application/javascript')
        except Exception as e:
            return web.Response(status=500, text=str(e))

    # 2. Execution Hooks (Monkey Patching send_sync)
    original_send_sync = server.PromptServer.instance.send_sync

    def holaf_profiler_hook_send_sync(event, data, sid=None):
        try:
            if profiler_engine.is_profiling:
                if event == 'executing':
                    node_id = data.get('node')
                    if node_id:
                        if profiler_engine.current_node_id is not None:
                            profiler_engine.on_node_end()
                        profiler_engine.handle_execution_start(node_id)
                    else:
                        if profiler_engine.current_node_id is not None:
                            profiler_engine.on_node_end()
                elif event in ('execution_error', 'execution_finished', 'execution_success', 'execution_interrupted'):
                    if profiler_engine.current_node_id is not None:
                        profiler_engine.on_node_end()
                    profiler_engine.stop_run()
        except Exception as e:
            print(f"🔴 [Holaf-Profiler-Hook] Error: {e}")
            traceback.print_exc()
        return original_send_sync(event, data, sid)

    server.PromptServer.instance.send_sync = holaf_profiler_hook_send_sync
    print("🔵 [Holaf-Init] Profiler hooks registered (send_sync patched).")

    # --- NEW: Profiler Run Management Routes ---
    @routes.get("/holaf/profiler/runs")
    async def profiler_list_runs(request: web.Request):
        try:
            limit = int(request.query.get('limit', 50))
            offset = int(request.query.get('offset', 0))
            runs = profiler_engine.db.list_runs(limit=limit, offset=offset)
            return web.json_response({"runs": runs})
        except Exception as e:
            print(f"🔴 [Profiler] Error listing runs: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/holaf/profiler/run/{run_id}/meta")
    async def profiler_get_run_meta(request: web.Request):
        try:
            run_id = request.match_info['run_id']
            run = profiler_engine.db.get_run(run_id)
            if run is None:
                return web.json_response({"error": "Run not found"}, status=404)
            return web.json_response({"run": run})
        except Exception as e:
            print(f"🔴 [Profiler] Error fetching run meta: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @routes.patch("/holaf/profiler/run/{run_id}/comment")
    async def profiler_update_run_comment(request: web.Request):
        try:
            run_id = request.match_info['run_id']
            data = await request.json()
            comment = data.get('comment', '')
            profiler_engine.db.update_run_comment(run_id, comment)
            return web.json_response({"status": "ok"})
        except Exception as e:
            print(f"🔴 [Profiler] Error updating comment: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @routes.patch("/holaf/profiler/run/{run_id}/output")
    async def profiler_update_run_output(request: web.Request):
        try:
            run_id = request.match_info['run_id']
            data = await request.json()
            path = data.get('path', '')
            profiler_engine.db.update_run_output(run_id, path)
            return web.json_response({"status": "ok"})
        except Exception as e:
            print(f"🔴 [Profiler] Error updating output: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/holaf/profiler/run/{run_id}/workflow")
    async def profiler_get_run_workflow(request: web.Request):
        try:
            run_id = request.match_info['run_id']
            workflow_json = profiler_engine.db.get_workflow_json(run_id)
            if workflow_json is None:
                return web.json_response({"error": "No workflow found"}, status=404)
            # workflow_json is a JSON string; return it parsed as a JSON object
            try:
                parsed = json.loads(workflow_json)
                return web.json_response({"workflow": parsed})
            except (ValueError, TypeError):
                return web.json_response({"workflow": workflow_json})
        except Exception as e:
            print(f"🔴 [Profiler] Error fetching workflow: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @routes.delete("/holaf/profiler/run/{run_id}")
    async def profiler_delete_run(request: web.Request):
        try:
            run_id = request.match_info['run_id']
            profiler_engine.db.delete_run(run_id)
            return web.json_response({"status": "ok"})
        except Exception as e:
            print(f"🔴 [Profiler] Error deleting run: {e}")
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/holaf/profiler/compare")
    async def profiler_compare_runs(request: web.Request):
        try:
            data = await request.json()
            run_ids = data.get('run_ids', [])
            if not run_ids:
                return web.json_response({"error": "No run_ids provided"}, status=400)

            result = []
            for run_id in run_ids:
                meta = profiler_engine.db.get_run(run_id)
                summary = profiler_engine.db.get_run_summary(run_id)
                result.append({
                    "run_id": run_id,
                    "meta": meta,
                    "summary": summary,
                })

            steps = profiler_engine.db.get_steps_for_comparison(run_ids)
            return web.json_response({"runs": result, "steps": steps})
        except Exception as e:
            print(f"🔴 [Profiler] Error comparing runs: {e}")
            return web.json_response({"error": str(e)}, status=500)

# --- NEW ROUTE: Standalone Gallery View ---
@routes.get("/holaf/view")
async def gallery_view_route(request: web.Request):
    return web.Response(text=GALLERY_HTML, content_type='text/html')

@routes.get("/holaf/comparer")
async def comparer_view_route(request: web.Request):
    return web.Response(text=COMPARER_HTML, content_type='text/html')
# ------------------------------------------

# Shared/Utility Routes
@routes.get("/holaf/utilities/settings")
async def holaf_get_all_settings_route(request: web.Request):
    current_live_config = CONFIG # Use the live global CONFIG
    password_is_set = current_live_config.get('password_hash') is not None
    response_data = {
        "password_is_set": password_is_set,
        "TerminalUI": current_live_config.get('ui_terminal'),
        "ModelManagerUI": current_live_config.get('ui_model_manager'),
        "ImageViewerUI": current_live_config.get('ui_image_viewer'),
        "NodesManagerUI": current_live_config.get('ui_nodes_manager')
    }
    return web.json_response(response_data)

@routes.post("/holaf/utilities/save-all-settings")
async def holaf_save_all_settings_route(request: web.Request):
    try:
        data = await request.json()
        await holaf_config.save_bulk_settings_to_config(data)
        reload_global_config() # Reload to reflect changes in the live CONFIG
        return web.json_response({"status": "ok", "message": "All settings saved."})
    except Exception as e:
        print(f"🔴 [Holaf-Init] Error saving all settings: {e}"); traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)

@routes.post("/holaf/utilities/restart")
@holaf_auth.require_auth
async def holaf_restart_server_route(request: web.Request):
    return await holaf_server_management.restart_server_route(request)

# Shared Auth Routes
@routes.post("/holaf/auth/login")
async def holaf_auth_login_route(request: web.Request):
    return await holaf_auth.login_route(request, CONFIG)

@routes.post("/holaf/auth/logout")
async def holaf_auth_logout_route(request: web.Request):
    return await holaf_auth.logout_route(request)

@routes.get("/holaf/auth/status")
async def holaf_auth_status_route(request: web.Request):
    return await holaf_auth.status_route(request, CONFIG)

# Terminal Routes
@routes.post("/holaf/terminal/set-password")
async def holaf_terminal_set_password_route(request: web.Request):
    return await holaf_terminal.set_password_route(request, CONFIG)

@routes.post("/holaf/terminal/auth")
async def holaf_terminal_auth_route(request: web.Request):
    return await holaf_terminal.auth_route(request, CONFIG)

@routes.get("/holaf/terminal") # WebSocket
@holaf_auth.require_auth
async def holaf_terminal_websocket_route(request: web.Request):
    return await holaf_terminal.websocket_handler(request, CONFIG)

@routes.post("/holaf/terminal/save-settings")
async def holaf_terminal_save_ui_settings_route(request: web.Request):
    try:
        data = await request.json()
        async with holaf_config.CONFIG_LOCK:
            config_parser_obj = holaf_config.get_config_parser()
            section = 'TerminalUI'
            if not config_parser_obj.has_section(section): config_parser_obj.add_section(section)

            for key, value_type in [('theme', str), ('font_size', int),
                                    ('panel_width', int), ('panel_height', int),
                                    ('panel_is_fullscreen', bool)]:
                if key in data:
                    val = data[key]
                    config_parser_obj.set(section, key, str(val))
                    if CONFIG.get('ui_terminal'): CONFIG['ui_terminal'][key] = value_type(val)

            for key_pos in ['panel_x', 'panel_y']:
                 if key_pos in data:
                    val = data[key_pos]
                    if val is not None:
                        config_parser_obj.set(section, key_pos, str(val))
                        if CONFIG.get('ui_terminal'): CONFIG['ui_terminal'][key_pos] = int(val)
                    else:
                        if config_parser_obj.has_option(section, key_pos): config_parser_obj.remove_option(section, key_pos)
                        if CONFIG.get('ui_terminal'): CONFIG['ui_terminal'][key_pos] = None

            with open(holaf_config.get_config_path(), 'w') as cf: config_parser_obj.write(cf)
        reload_global_config()
        return web.json_response({"status": "ok", "message": "Terminal UI settings saved."})
    except Exception as e:
        print(f"🔴 Error saving Terminal UI settings: {e}"); traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)

# Model Manager Routes (thin wrappers around model_manager_helper)
MODEL_TYPES_CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'model_types.json')

@routes.get("/holaf/models/config")
async def get_model_types_config_route(request: web.Request):
    if not os.path.exists(MODEL_TYPES_CONFIG_PATH):
        return web.json_response({"error": "model_types.json not found"}, status=404)
    with open(MODEL_TYPES_CONFIG_PATH, 'r', encoding='utf-8') as f:
        return web.json_response(json.load(f))

@routes.post("/holaf/models/upload-chunk")
@holaf_auth.require_auth
async def upload_model_chunk_route(request: web.Request):
    try:
        data = await request.post()
        upload_id = holaf_utils.sanitize_upload_id(data.get('upload_id'))
        chunk_idx = data.get('chunk_index')
        file_chunk = data.get('file_chunk')
        # Validate chunk_index is a non-negative integer
        try:
            chunk_idx = int(chunk_idx)
            if chunk_idx < 0: raise ValueError
        except (ValueError, TypeError):
            return web.json_response({"status": "error", "message": "chunk_index must be a non-negative integer."}, status=400)
        if not all([upload_id, file_chunk]):
            return web.json_response({"status": "error", "message": "Missing required fields."}, status=400)
        chunk_path = os.path.join(holaf_utils.TEMP_UPLOAD_DIR, f"{upload_id}-{chunk_idx}.chunk")
        if not os.path.normpath(chunk_path).startswith(os.path.normpath(holaf_utils.TEMP_UPLOAD_DIR)):
             return web.json_response({"status": "error", "message": "Invalid chunk path."}, status=400)
        with open(chunk_path, 'wb') as f: f.write(file_chunk.file.read())
        return web.json_response({"status": "ok", "message": f"Chunk {chunk_idx} received."})
    except Exception as e:
        print(f"🔴 Error processing chunk: {e}"); traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)

@routes.post("/holaf/models/finalize-upload")
@holaf_auth.require_auth
async def finalize_upload_model_route(request: web.Request):
    try:
        data = await request.json()
        upload_id = holaf_utils.sanitize_upload_id(data.get('upload_id'))
        filename_orig = data.get('filename')
        total_chunks = data.get('total_chunks')
        dest_type = data.get('destination_type')
        subfolder = data.get('subfolder', '')
        # MODIFIED: Get only expected size from the request
        expected_size = data.get('expected_size')
        # expected_sha256 removed

        # MODIFIED: Update validation to remove checksum
        if not all([upload_id, filename_orig, total_chunks, dest_type, expected_size]):
            return web.json_response({"status": "error", "message": "Missing fields, including expected size."}, status=400)

        # Validate numeric fields
        try:
            total_chunks = int(total_chunks)
            if total_chunks <= 0 or total_chunks > 10000:
                raise ValueError
        except (ValueError, TypeError):
            return web.json_response({"status": "error", "message": "total_chunks must be a positive integer (max 10000)."}, status=400)
        try:
            expected_size = int(expected_size)
            if expected_size < 0:
                raise ValueError
        except (ValueError, TypeError):
            return web.json_response({"status": "error", "message": "expected_size must be a non-negative integer."}, status=400)

        filename = holaf_utils.sanitize_filename(filename_orig)
        if not filename: return web.json_response({"status": "error", "message": "Invalid filename."}, status=400)

        base_paths = folder_paths.get_folder_paths(dest_type)
        if not base_paths: return web.json_response({"error": f"Invalid dest type '{dest_type}'"}, status=400)

        # Use re.split for subfolder to handle both / and \
        final_subfolder_parts = [p for p in map(holaf_utils.sanitize_directory_component, re.split(r'[/\\]', subfolder)) if p]
        final_dest_dir = os.path.join(os.path.normpath(base_paths[0]), *final_subfolder_parts)
        final_save_path = os.path.normpath(os.path.join(final_dest_dir, filename))

        comfy_base = os.path.normpath(folder_paths.base_path)
        rel_save_path = os.path.relpath(final_save_path, comfy_base).replace(os.sep, '/')

        if model_manager_helper and not model_manager_helper.is_path_safe(rel_save_path, is_directory_model=False):
             return web.json_response({"status": "error", "message": "Save path outside allowed model dirs."}, status=403)
        if os.path.exists(final_save_path):
            return web.json_response({"status": "error", "message": "File already exists."}, status=409)

        def on_assembly_done():
            if model_manager_helper and hasattr(model_manager_helper, 'scan_and_update_db'):
                threading.Timer(1.0, model_manager_helper.scan_and_update_db).start()

        loop = asyncio.get_running_loop()
        # MODIFIED: Pass only expected_size to the assembly function
        await loop.run_in_executor(None, holaf_utils.assemble_chunks_blocking,
                                   final_save_path, upload_id, total_chunks, on_assembly_done,
                                   expected_size)
        return web.json_response({"status": "ok", "message": f"Finalization for '{filename}' started."})
    except Exception as e:
        print(f"🔴 Error finalizing upload: {e}"); traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)

if model_manager_helper:
    @routes.get("/holaf/models")
    async def get_models_route(request: web.Request):
        try:
            models = model_manager_helper.get_all_models_from_db()
            return web.json_response(models)
        except Exception as e:
            print(f"🔴 [MM] Error fetching models: {e}"); traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/holaf/models/deep-scan-local")
    @holaf_auth.require_auth
    async def model_deep_scan_route(request: web.Request):
        try:
            data = await request.json()
            paths = data.get("paths")
            if not paths or not isinstance(paths, list):
                return web.json_response({"error": "'paths' list required."}, status=400)
            loop = asyncio.get_running_loop()
            results = await loop.run_in_executor(None, model_manager_helper.process_deep_scan_request, paths)
            return web.json_response({"status": "ok", "details": results})
        except Exception as e:
            print(f"🔴 [MM] Error deep scanning: {e}"); traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/holaf/models/delete") # This is for Model Manager, distinct from Image Viewer delete
    @holaf_auth.require_auth
    async def delete_model_route(request: web.Request):
        try:
            data = await request.json()
            paths = data.get("paths", [])
            if not paths or not isinstance(paths, list):
                return web.json_response({"error": "'paths' list required."}, status=400)
            
            loop = asyncio.get_running_loop()
            results = await loop.run_in_executor(None, model_manager_helper.delete_models_from_db_and_disk, paths)
            return web.json_response(results)
        except Exception as e:
            print(f"🔴 [MM] Error deleting models: {e}"); traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/holaf/model-manager/save-settings")
    async def model_manager_save_ui_settings_route(request: web.Request):
        try:
            data = await request.json()
            async with holaf_config.CONFIG_LOCK:
                cp = holaf_config.get_config_parser()
                s = 'ModelManagerUI'
                if not cp.has_section(s): cp.add_section(s)

                map_cfg = {'theme': str, 'panel_width': int, 'panel_height': int,
                           'filter_type': str, 'filter_search_text': str,
                           'sort_column': str, 'sort_order': str, 'zoom_level': float,
                           'panel_is_fullscreen': bool}
                for k, v_type in map_cfg.items():
                    if k in data:
                        val = data[k]
                        cp.set(s, k, str(val))
                        if CONFIG.get('ui_model_manager'): CONFIG['ui_model_manager'][k] = v_type(val)
                for k_pos in ['panel_x', 'panel_y']:
                    if k_pos in data:
                        val = data[k_pos]
                        if val is not None:
                            cp.set(s, k_pos, str(val))
                            if CONFIG.get('ui_model_manager'): CONFIG['ui_model_manager'][k_pos] = int(val)
                        else:
                            if cp.has_option(s,k_pos): cp.remove_option(s,k_pos)
                            if CONFIG.get('ui_model_manager'): CONFIG['ui_model_manager'][k_pos] = None
                with open(holaf_config.get_config_path(), 'w') as cf: cp.write(cf)
            reload_global_config()
            return web.json_response({"status": "ok", "message": "Model Manager UI settings saved."})
        except Exception as e:
            print(f"🔴 Error saving MM UI settings: {e}"); traceback.print_exc()
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.post("/holaf/models/download-chunk")
    async def download_model_chunk_route(request: web.Request):
        try:
            data = await request.json()
            path_canon = data.get("path")

            # Validate client-controlled chunk parameters (bounds + type safety)
            try:
                chunk_index = int(data.get("chunk_index"))
                chunk_size = int(data.get("chunk_size"))
            except (TypeError, ValueError):
                return web.Response(status=400, text="Invalid chunk parameters.")
            if chunk_index < 0:
                return web.Response(status=400, text="Invalid chunk_index.")
            if chunk_size <= 0 or chunk_size > 64 * 1024 * 1024:
                return web.Response(status=400, text="Invalid chunk_size.")

            if not model_manager_helper.is_path_safe(path_canon, is_directory_model=False):
                return web.Response(status=403, text="Access forbidden.")

            comfy_base = os.path.normpath(folder_paths.base_path)
            is_abs = path_canon.startswith('/') or (os.name == 'nt' and len(path_canon) > 1 and path_canon[1] == ':')
            abs_model_path = os.path.normpath(path_canon if is_abs else os.path.join(comfy_base, path_canon))

            if not os.path.isfile(abs_model_path):
                return web.Response(status=404, text="Model file not found.")

            offset = chunk_index * chunk_size
            chunk_data = await holaf_utils.read_file_chunk(abs_model_path, offset, chunk_size)
            if chunk_data is None: raise IOError("File could not be read.")
            return web.Response(body=chunk_data, content_type='application/octet-stream')
        except Exception as e:
            print(f"🔴 [MM] Error downloading chunk: {e}"); traceback.print_exc()
            return web.Response(status=500, text=str(e))

# --- Image Viewer Routes ---
@routes.get("/holaf/images/filter-options")
async def iv_filter_options_route(r): return await holaf_image_viewer_backend.get_filter_options_route(r)

@routes.post("/holaf/images/list")
async def iv_list_images_route(r): return await holaf_image_viewer_backend.list_images_route(r)

@routes.get("/holaf/images/thumbnail")
async def iv_get_thumbnail_route(r): return await holaf_image_viewer_backend.get_thumbnail_route(r)

@routes.get("/holaf/images/full")
async def iv_get_full_image_route(r): return await holaf_image_viewer_backend.get_full_image_route(r)

@routes.get("/holaf/images/perf")
async def iv_get_perf_route(r): return await holaf_image_viewer_backend.get_perf_route(r)

@routes.get("/holaf/images/metadata")
async def iv_get_metadata_route(r): return await holaf_image_viewer_backend.get_metadata_route(r)

# --- MODIFICATION START: Add route for checking last update time ---
@routes.get("/holaf/images/last-update-time")
async def iv_get_last_update_time_route(request: web.Request):
    return web.json_response({"last_update": holaf_image_viewer_backend.logic.LAST_DB_UPDATE_TIME})
# --- MODIFICATION END ---


# Image Viewer Actions
@routes.post("/holaf/images/delete")
async def iv_delete_images_route(r): return await holaf_image_viewer_backend.delete_images_route(r)

@routes.post("/holaf/images/delete-permanently")
async def iv_delete_images_permanently_route(r): return await holaf_image_viewer_backend.delete_images_permanently_route(r)

@routes.post("/holaf/images/restore")
async def iv_restore_images_route(r): return await holaf_image_viewer_backend.restore_images_route(r)

@routes.post("/holaf/images/empty-trashcan")
async def iv_empty_trashcan_route(r): return await holaf_image_viewer_backend.empty_trashcan_route(r)

@routes.post("/holaf/images/extract-metadata")
async def iv_extract_metadata_route(r): return await holaf_image_viewer_backend.extract_metadata_route(r)

@routes.post("/holaf/images/inject-metadata")
async def iv_inject_metadata_route(r): return await holaf_image_viewer_backend.inject_metadata_route(r)

@routes.post("/holaf/images/prepare-export")
async def iv_prepare_export_route(r): return await holaf_image_viewer_backend.prepare_export_route(r)

@routes.get("/holaf/images/export-chunk")
async def iv_download_export_chunk_route(r): return await holaf_image_viewer_backend.download_export_chunk_route(r)

# --- MODIFICATION START: Add new edit routes ---
@routes.get("/holaf/images/load-edits")
async def iv_load_edits_route(r): return await holaf_image_viewer_backend.load_edits_route(r)

@routes.post("/holaf/images/save-edits")
async def iv_save_edits_route(r): return await holaf_image_viewer_backend.save_edits_route(r)

@routes.post("/holaf/images/delete-edits")
async def iv_delete_edits_route(r): return await holaf_image_viewer_backend.delete_edits_route(r)

@routes.post("/holaf/images/process-video") # <-- NEW: Register Process Video
async def iv_process_video_route(r): return await holaf_image_viewer_backend.process_video_route(r)

@routes.post("/holaf/images/rollback-video") # <-- NEW: Register Rollback
async def iv_rollback_video_route(r): return await holaf_image_viewer_backend.rollback_video_route(r)

@routes.post("/holaf/images/maintenance/sync-database")
async def iv_sync_database_route(r): return await holaf_image_viewer_backend.sync_database_route(r)

@routes.post("/holaf/images/maintenance/clean-thumbnails")
async def iv_clean_thumbnails_route(r): return await holaf_image_viewer_backend.clean_thumbnails_route(r)
# --- MODIFICATION END ---

# Image Viewer Thumbnail Worker and Stats
@routes.post("/holaf/images/viewer-activity")
async def iv_set_viewer_activity_route(r): return await holaf_image_viewer_backend.set_viewer_activity_route(r)

@routes.post("/holaf/images/prioritize-thumbnails")
async def iv_prioritize_thumbnails_route(r): return await holaf_image_viewer_backend.prioritize_thumbnails_route(r)

# <-- MODIFICATION START: Nouvelle route pour la régénération de miniature -->
@routes.post('/holaf/images/regenerate-thumbnail')
async def iv_regenerate_thumbnail_route(r):
    return await holaf_image_viewer_backend.regenerate_thumbnail_route(r)
# <-- MODIFICATION END -->

# <-- MODIFICATION START: Nouvelle route pour la régénération des miniatures en échec -->
@routes.post("/holaf/images/regenerate-failed")
async def iv_regenerate_failed_thumbnails_route(r):
    return await holaf_image_viewer_backend.regenerate_failed_thumbnails_route(r)
# <-- MODIFICATION END -->

@routes.get("/holaf/images/thumbnail-stats")
async def iv_thumbnail_stats_route(r): return await holaf_image_viewer_backend.iv_get_thumbnail_stats_route(r)

@routes.get("/holaf/images/thumbnail-diagnose")
async def iv_thumbnail_diagnose_route(r): return await holaf_image_viewer_backend.thumbnail_diagnose_route(r)

@routes.post("/holaf/image-viewer/save-settings")
async def image_viewer_save_ui_settings_route(request: web.Request):
    try:
        data = await request.json()
        async with holaf_config.CONFIG_LOCK:
            cp = holaf_config.get_config_parser()
            s = 'ImageViewerUI'
            if not cp.has_section(s): cp.add_section(s)

            # Consolidate panel dimension keys
            pos_x = data.get('panel_x', data.get('x'))
            pos_y = data.get('panel_y', data.get('y'))
            width = data.get('panel_width', data.get('width'))
            height = data.get('panel_height', data.get('height'))

            # Handle panel position and size
            if pos_x is not None: cp.set(s, 'panel_x', str(int(pos_x)))
            else:
                if cp.has_option(s, 'panel_x'): cp.remove_option(s, 'panel_x')
            if pos_y is not None: cp.set(s, 'panel_y', str(int(pos_y)))
            else:
                if cp.has_option(s, 'panel_y'): cp.remove_option(s, 'panel_y')
            if width is not None: cp.set(s, 'panel_width', str(int(width)))
            if height is not None: cp.set(s, 'panel_height', str(int(height)))
            
            # Handle other specific settings
            keys_to_save = [
                'panel_is_fullscreen', 'thumbnail_fit', 'thumbnail_size', 'theme', 
                'export_format', 'export_include_meta', 'export_meta_method',
                'search_text', 'search_scope_name', 'search_scope_prompt', 'search_scope_workflow',
                'workflow_filter_internal', 'workflow_filter_external'
            ]
            for key in keys_to_save:
                if key in data:
                    cp.set(s, key, str(data[key]))

            # Handle date keys separately for case consistency (JS: startDate, INI: startdate)
            if 'startDate' in data:
                cp.set(s, 'startdate', str(data['startDate']))
            if 'endDate' in data:
                cp.set(s, 'enddate', str(data['endDate']))
            
            # Handle list-type settings
            if 'folder_filters' in data and isinstance(data['folder_filters'], list):
                cp.set(s, 'folder_filters', json.dumps(data['folder_filters'])) # Store as JSON string
            if 'format_filters' in data and isinstance(data['format_filters'], list):
                cp.set(s, 'format_filters', json.dumps(data['format_filters'])) # Store as JSON string
            # --- CORRECTIF : Ajouter la sauvegarde de locked_folders ---
            if 'locked_folders' in data and isinstance(data['locked_folders'], list):
                cp.set(s, 'locked_folders', json.dumps(data['locked_folders'])) # Store as JSON string

            with open(holaf_config.get_config_path(), 'w') as cf: cp.write(cf)
        reload_global_config() # Reload to reflect changes in the live CONFIG
        return web.json_response({"status": "ok", "message": "Image Viewer settings saved."})
    except Exception as e:
        print(f"🔴 Error saving IV UI settings: {e}"); traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)

# Nodes Manager Routes (thin wrappers, assuming nodes_manager_helper exists)
if nodes_manager_helper:
    @routes.get("/holaf/nodes/list")
    async def nm_get_list_route(r):
        try:
            loop = asyncio.get_running_loop()
            node_list = await loop.run_in_executor(None, nodes_manager_helper.scan_custom_nodes)
            return web.json_response({"nodes": node_list})
        except Exception as e: print(f"🔴 [NM] Error list: {e}"); return web.json_response({"error":str(e)},500)

    async def _handle_node_action_batch(request: web.Request, action_func_name: str):
        try:
            data = await request.json()
            payloads = data.get("node_payloads", data.get("node_names", [])) # Accept old and new payload keys
            if not payloads: return web.json_response({"error": "No nodes specified"}, status=400)

            items_to_process = []
            # Standardize payload to a list of dicts
            for p_item in payloads:
                if isinstance(p_item, dict) and "name" in p_item: # New format: {"name": "...", "repo_url_override": "..."}
                    items_to_process.append(p_item)
                elif isinstance(p_item, str): # Old format: "node_name"
                    items_to_process.append({"name": p_item, "repo_url_override": None}) # Convert to new format

            results = []
            loop = asyncio.get_running_loop()
            action_func = getattr(nodes_manager_helper, action_func_name)

            for item_data in items_to_process:
                node_name = item_data["name"]
                if action_func_name == "update_node_from_git":
                     # Pass repo_url_override if present, otherwise it will be None and helper handles default
                     result = await loop.run_in_executor(None, action_func, node_name, item_data.get("repo_url_override"))
                else:
                     result = await loop.run_in_executor(None, action_func, node_name) # Other actions don't need repo_url
                results.append({"node_name": node_name, **result}) # Merge node_name with result dict

            all_ok = all(r.get('status') == 'success' for r in results)
            any_ok = any(r.get('status') == 'success' for r in results)
            http_status = 200 if all_ok else (207 if any_ok else 400) # 207 Multi-Status if some succeed
            overall_status = "ok" if all_ok else ("partial_success" if any_ok else "error")
            return web.json_response({"status": overall_status, "details": results}, status=http_status)

        except Exception as e: print(f"🔴 [NM] Batch action error: {e}"); return web.json_response({"error":str(e)},500)

    @routes.post("/holaf/nodes/update")
    @holaf_auth.require_auth
    async def nm_update_route(r): return await _handle_node_action_batch(r, "update_node_from_git")
    @routes.post("/holaf/nodes/delete")
    @holaf_auth.require_auth
    async def nm_delete_route(r): return await _handle_node_action_batch(r, "delete_node_folder")
    @routes.post("/holaf/nodes/install-requirements")
    @holaf_auth.require_auth
    async def nm_install_req_route(r): return await _handle_node_action_batch(r, "install_node_requirements")

    @routes.get("/holaf/nodes/readme/local/{node_name}")
    async def nm_get_local_readme(request: web.Request):
        try:
            node_name = request.match_info.get('node_name', "")
            loop = asyncio.get_running_loop()
            content = await loop.run_in_executor(None, nodes_manager_helper.get_local_readme_content, node_name)
            return web.Response(text=content, content_type='text/plain', charset='utf-8')
        except Exception as e: return web.Response(text=str(e), status=500)

    @routes.post("/holaf/nodes/readme/github")
    async def nm_get_github_readme(request: web.Request):
        try:
            data = await request.json()
            content = await nodes_manager_helper.get_github_readme_content(data.get("owner"), data.get("repo"))
            return web.Response(text=content, content_type='text/plain', charset='utf-8')
        except Exception as e: return web.Response(text=str(e), status=500)

    @routes.get("/holaf/nodes/search/github/{node_name}")
    async def nm_search_github(request: web.Request):
        try:
            node_name = request.match_info.get('node_name', "")
            repo_url = await nodes_manager_helper.search_github_for_repo(node_name)
            return web.json_response({"url": repo_url})
        except Exception as e: return web.json_response({"error": str(e)}, status=500)

    # --- Node Manager Install & Search Routes ---
    @routes.post("/holaf/nodes/install")
    @holaf_auth.require_auth
    async def nm_install_route(request: web.Request):
        if nodes_manager_helper is None:
            return web.json_response({"status": "error", "message": "Node manager module not available."}, status=503)
        try:
            data = await request.json()
            url = data.get("url")
            if not url:
                return web.json_response({"status": "error", "message": "URL is required."}, status=400)
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, nodes_manager_helper.install_custom_node, url)
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.post("/holaf/nodes/search")
    async def nm_search_route(request: web.Request):
        if nodes_manager_helper is None:
            return web.json_response({"status": "error", "message": "Node manager module not available."}, status=503)
        try:
            data = await request.json()
            query = data.get("query")
            if not query:
                return web.json_response({"status": "error", "message": "Query is required."}, status=400)
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, nodes_manager_helper.search_custom_nodes, query)
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)


# --- AIH HTTP Routes (/aih/* and /api/aih/*) ---
# Phase 2 chantier C (PLAN_FUSION.md §3.5) : toutes les routes AIH vivent
# dans le sous-package 'aih' (aih/routes.py) et sont enregistrées d'un bloc
# ici, après le bootstrap sys.path du package. Le décorateur d'authentification
# partagé Holaf est passé explicitement : il sécurise POST /aih/blobby/exec
# (même vérification par mot de passe que GET /holaf/terminal). L'enregistrement
# est défensif : un échec n'empêche pas le chargement du reste du pack.
try:
    from aih import routes as aih_routes
    _AIH_ROUTE_COUNT = aih_routes.register(routes, require_auth=holaf_auth.require_auth)
    if not _AIH_ROUTE_COUNT:
        print("🟡 [Holaf-Init] No AIH routes were registered.")
except Exception as _aih_routes_err:
    print(f"🔴 [Holaf-Init] AIH routes registration failed: {_aih_routes_err}")
    traceback.print_exc()

# --- Dynamic Node Loading from 'nodes/' directory ---
NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS = {}, {}
nodes_dir_path = os.path.join(os.path.dirname(__file__), "nodes")
if os.path.isdir(nodes_dir_path):
    for filename in os.listdir(nodes_dir_path):
        if filename.endswith(".py") and not filename.startswith("__"):
            # Synthetic sys.modules key (modules are loaded by file path via
            # spec_from_file_location); derived from this package's own name
            # so it stays consistent if the extension folder is renamed.
            module_name = f"{__name__}.nodes.{os.path.splitext(filename)[0]}"
            full_module_path_for_spec = os.path.join(nodes_dir_path, filename)
            try:
                spec = importlib.util.spec_from_file_location(module_name, full_module_path_for_spec)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[module_name] = module # Add to sys.modules before exec_module
                    spec.loader.exec_module(module)
                    if hasattr(module, "NODE_CLASS_MAPPINGS"):
                        NODE_CLASS_MAPPINGS.update(module.NODE_CLASS_MAPPINGS)
                        print(f"  > Loaded nodes from: {filename}")
                    if hasattr(module, "NODE_DISPLAY_NAME_MAPPINGS"):
                        NODE_DISPLAY_NAME_MAPPINGS.update(module.NODE_DISPLAY_NAME_MAPPINGS)
                else:
                    print(f"🔴 [Holaf-Init] Could not create spec for module: {filename}")
            except Exception as e:
                print(f"🔴 [Holaf-Init] Error loading node module {filename}: {e}", file=sys.stderr)
                traceback.print_exc()
else:
    print("🟡 [Holaf-Init] 'nodes' directory not found. No additional custom nodes loaded.")


# --- ComfyUI Extension Registration ---
WEB_DIRECTORY = "js"

# --- Background Periodic Tasks & Worker Threads ---
stop_event = threading.Event()
all_background_threads = [] # Keep track of threads for cleaner shutdown if needed

def _periodic_task_wrapper(interval_seconds, task_func, *args, **kwargs):
    def task_loop():
        initial_delay = kwargs.pop('initial_delay', 0)
        if initial_delay > 0:
             if stop_event.wait(initial_delay): return # Exit if stop_event set during delay

        while not stop_event.is_set():
            try:
                task_func(*args, **kwargs)
            except Exception as e:
                print(f"🔴 [Holaf-Periodic] Error in '{task_func.__name__}': {e}")
                traceback.print_exc()
            if stop_event.wait(interval_seconds): break # Exit if stop_event set during wait

    thread = threading.Thread(target=task_loop, daemon=True)
    thread.start()
    all_background_threads.append(thread) # Add to list
    return thread

# --- MODIFICATION START: Consolidate worker startups ---
thumbnail_worker_thread_ref = None
filesystem_workers_started = False

def start_thumbnail_worker():
    global thumbnail_worker_thread_ref
    if thumbnail_worker_thread_ref is None or not thumbnail_worker_thread_ref.is_alive():
        print("🔵 [Holaf-Init] Starting Thumbnail Generation Worker thread...")
        thumbnail_worker_thread_ref = threading.Thread(
            target=holaf_image_viewer_backend.worker.run_thumbnail_generation_worker,
            args=(stop_event,), daemon=True, name="HolafThumbWorker"
        )
        thumbnail_worker_thread_ref.start()
        all_background_threads.append(thumbnail_worker_thread_ref)
    else:
        print("🟡 [Holaf-Init] Thumbnail Generation Worker thread already running.")

def start_filesystem_workers():
    global filesystem_workers_started
    if not filesystem_workers_started:
        print("🔵 [Holaf-Init] Starting Filesystem Watcher workers...")
        
        monitor_thread = threading.Thread(
            target=holaf_image_viewer_backend.worker.run_filesystem_monitor,
            args=(stop_event,), daemon=True, name="HolafFsMonitor"
        )
        processor_thread = threading.Thread(
            target=holaf_image_viewer_backend.worker.run_event_queue_processor,
            args=(stop_event,), daemon=True, name="HolafFsProcessor"
        )

        monitor_thread.start()
        processor_thread.start()
        
        all_background_threads.extend([monitor_thread, processor_thread])
        filesystem_workers_started = True
    else:
        print("🟡 [Holaf-Init] Filesystem Watcher workers already running.")
# --- MODIFICATION END ---


def shutdown_tasks():
    print("🔵 [Holaf-Init] Signaling background tasks and workers to stop...")
    stop_event.set()
    print("🔵 [Holaf-Init] Shutdown signal process complete.")

try:
    if hasattr(server.PromptServer.instance, "add_on_shutdown"):
        server.PromptServer.instance.add_on_shutdown(shutdown_tasks)
        print("🔵 [Holaf-Init] Registered shutdown_tasks with ComfyUI server.")
    else:
        print("🟡 [Holaf-Init] server.add_on_shutdown not available. Background tasks will rely on daemon status for exit.")
except AttributeError:
    print("🟡 [Holaf-Init] AttributeError registering shutdown_tasks. Background tasks will rely on daemon status for exit.")


print("🔵 [Holaf-Init] Scheduling startup and periodic background tasks...")

# Model Manager initial scan
if model_manager_helper and hasattr(model_manager_helper, 'scan_and_update_db'):
    _periodic_task_wrapper(3600, model_manager_helper.scan_and_update_db, initial_delay=5.0)
else:
    print("🟡 [Holaf-Init] Model Manager scan_and_update_db not available for scheduling.")

# Sync is a safety net: the custom scandir-based poller handles real-time adds
# and deletes (name-diff, no per-file stat). The 30s sync covers in-place content
# updates and renames, which the name-diff poller does not detect without
# re-stat'ing every file on the ~30k-file tree. 30s keeps fresh content visible
# quickly while remaining cheap enough for periodic full scans.
# Safety-net sync: the filesystem watcher (inotify / custom poller) handles
# real-time adds/deletes. A full-tree os.walk + os.stat every 30s saturates
# slow filesystems (huge trees on Docker volumes) and starves the watcher's
# adds, delaying new images by minutes. Run it rarely (5 min) as a pure fallback.
_periodic_task_wrapper(300.0, holaf_image_viewer_backend.sync_image_database_blocking, initial_delay=10.0)

# --- MODIFICATION START: Correctly schedule all image viewer workers ---
thumbnail_startup_timer = threading.Timer(15.0, start_thumbnail_worker)
thumbnail_startup_timer.daemon = True
thumbnail_startup_timer.start()

filesystem_startup_timer = threading.Timer(16.0, start_filesystem_workers)
filesystem_startup_timer.daemon = True
filesystem_startup_timer.start()
# --- MODIFICATION END ---


# --- Final Initialization Message ---
print("\n" + "="*50)
print("✅ [Holaf-Utilities] Extension initialized with modular structure.")
final_config = CONFIG # Use the reloaded global CONFIG
print(f"  > Terminal Shell: {final_config.get('shell_command', 'N/A')}")
if final_config.get('password_hash'):
    print("  > Terminal Status: 🔑 Password is set.")
else:
    print("  > Terminal Status: 🔵 No password set. Setup required.")
if not NODE_CLASS_MAPPINGS:
    print("  > Additional Nodes: None found or loaded from 'nodes/' directory.")
print("="*50 + "\n")
sys.stdout.flush()

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']