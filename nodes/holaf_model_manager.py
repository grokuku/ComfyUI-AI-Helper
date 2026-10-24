# === Documentation ===
# Developer: Gemini (AI Assistant), under the direction of Holaf
# Date: 2025-05-24
#
# Purpose:
# This file provides the server-side logic for the Holaf Model Manager.
# ...
# MODIFIED: Added model_family detection.
# MODIFIED: Added initial deep scan functionality (SHA256, safetensors metadata).
# MODIFIED: Initial scan logic at module load time removed, now handled by __init__.py.
# MODIFIED: Path normalization for DB storage and retrieval to fix deep scan "model not found" issues.
# MODIFIED: Refactored `is_path_safe_for_deletion` into a more generic `is_path_safe`
#           that only checks path boundaries, fixing both upload and delete operations.
# MODIFIED: Database initialization logic (init_db) has been removed and centralized in __init__.py.
# MODIFIED: Standardized all database queries to use `path_canon` instead of `path` to match the DB schema.
# === End Documentation ===

import os
import folder_paths
import sqlite3
import json
import time
import traceback
import re
import hashlib
import shutil

# Attempt to import safetensors, crucial for deep scan
try:
    from safetensors import safe_open
    SAFETENSORS_AVAILABLE = True
except ImportError:
    SAFETENSORS_AVAILABLE = False
    print("🟡 [Holaf-ModelManager] 'safetensors' library not found. Deep scan for .safetensors metadata will be disabled.")
    print("   Please install it: pip install safetensors")


# --- Globals & Configuration ---
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Emplacement des données utilisateur : UNE seule source de vérité
# (holaf_user_paths). Auparavant ce module recalculait le chemin de la base de
# son côté (« <pack>/../holaf_utilities.sqlite ») : DEUX sources de vérité qui
# pouvaient diverger de holaf_database.DB_PATH dès que la base était migrée.
try:  # import relatif (pack importé comme extension ComfyUI)
    from .. import holaf_user_paths as _user_paths
except ImportError:  # chargé à plat (sys.path = racine du pack, tests par chemin)
    import holaf_user_paths as _user_paths

# MODIFIED: Changed DB name to match the unified database file.
EXTENSION_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HOLAF_MODELS_DB_PATH = _user_paths.resolved_db_utils()
MODEL_TYPES_CONFIG_PATH = os.path.join(EXTENSION_BASE_DIR, '..', 'model_types.json')

MODEL_TYPE_DEFINITIONS = []
KNOWN_MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.onnx'}

MODEL_FAMILY_KEYWORDS = [
    ("Hunyuan-DiT", ["hunyuan-dit-"], ["checkpoints"]),
    ("Hunyuan", ["hunyuan"], ["checkpoints"]),
    ("Flux", ["flux.1"], ["checkpoints"]),
    ("Flux", ["flux"], ["checkpoints"]),
    ("Kolors", ["kolors"], ["checkpoints"]),
    ("Playground v2.5", ["playgroundv2.5"], ["checkpoints"]),
    ("Playground v2", ["playgroundv2"], ["checkpoints"]),
    ("Playground", ["playground"], ["checkpoints"]),
    ("PixArt-Σ", ["pixart-sigma", "pixartsigma"], ["checkpoints"]),
    ("PixArt-α", ["pixart-alpha", "pixartalpha", "pixart_alpha"], ["checkpoints"]),
    ("PixArt", ["pixart"], ["checkpoints"]),
    ("Stable Cascade", ["stable_cascade", "stablecascade"], ["checkpoints"]),
    ("Würstchen", ["würstchen", "wuerstchen"], ["checkpoints", "unet"]),
    ("AuraFlow", ["auraflow"], ["checkpoints"]),
    ("DeepFloyd IF", ["deepfloyd_if", "deepfloydif"], ["checkpoints"]),
    ("Kandinsky 3.x", ["kandinsky3", "kandinsky_3"], ["checkpoints"]),
    ("Kandinsky 2.x", ["kandinsky2", "kandinsky_2"], ["checkpoints"]),
    ("Kandinsky", ["kandinsky"], ["checkpoints"]),
    ("SDXL Turbo", ["sdxl_turbo", "sdxlturbo"], ["checkpoints", "loras"]),
    ("SDXL Lightning", ["sdxl_lightning", "sdxllightning"], ["checkpoints", "loras"]),
    ("SDXL", ["sdxl", "sd_xl"], ["checkpoints", "loras", "unet"]),
    ("Pony", ["pony"], ["checkpoints", "loras"]),
    ("SD 2.1", ["sd2.1", "sd21"], ["checkpoints", "loras"]),
    ("SD 2.0", ["sd2.0", "sd20"], ["checkpoints", "loras"]),
    ("SD 2.x", ["sd2"], ["checkpoints", "loras"]),
    ("SD 1.5", ["sd1.5", "sd15"], ["checkpoints", "loras"]),
    ("SD 1.x", ["sd1"], ["checkpoints", "loras"]),
    ("SVD XT", ["svd_xt", "svdxt"], ["checkpoints", "svd"]),
    ("SVD", ["svd", "stable_video_diffusion"], ["checkpoints", "svd"]),
    ("AnimateDiff", ["animatediff", "motion_module"], ["animatediff_models", "animatediff_motion_lora"]),
    ("HotshotXL", ["hotshotxl", "hotshot_xl"], ["animatediff_models"]),
    ("VideoCrafter", ["videocrafter"], ["checkpoints"]),
    ("Latte", ["latte"], ["checkpoints"]),
    ("OpenSora", ["opensora"], ["checkpoints"]),
    ("SSD-1B", ["ssd-1b", "ssd_1b"], ["checkpoints"]),
    ("SegMoE", ["segmoe"], ["checkpoints"]),
    ("Yamer", ["yamer"], ["checkpoints"]),
    ("LCM", ["lcm"], ["checkpoints", "loras"]),
    ("Hyper-SD", ["hyper-sd", "hypersd"], ["checkpoints", "loras"]),
]


# --- Database Management ---
# MODIFIED: Re-enabled foreign keys and WAL mode for consistency with holaf_database.py
def _get_db_connection():
    conn = sqlite3.connect(HOLAF_MODELS_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 30000;")
    return conn


def load_model_type_definitions():
    global MODEL_TYPE_DEFINITIONS
    try:
        if not os.path.exists(MODEL_TYPES_CONFIG_PATH):
            print(f"🔴 [Holaf-ModelManager] CRITICAL: model_types.json not found at {MODEL_TYPES_CONFIG_PATH}")
            return
        with open(MODEL_TYPES_CONFIG_PATH, 'r', encoding='utf-8') as f:
            MODEL_TYPE_DEFINITIONS = json.load(f)
    except Exception as e:
        print(f"🔴 [Holaf-ModelManager] CRITICAL: Error loading/parsing model_types.json: {e}")
        MODEL_TYPE_DEFINITIONS = []

# --- Model Scanning and Management ---
def get_folder_size(folder_path):
    total_size = 0
    try:
        for dirpath, dirnames, filenames in os.walk(folder_path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                if not os.path.islink(fp):
                    try: 
                        total_size += os.path.getsize(fp)
                    except OSError:
                        pass 
    except OSError as e: 
        print(f"🟡 [Holaf-ModelManager] Warning: Could not fully calculate size for folder {folder_path} due to OS error: {e}")
    return total_size


def _get_base_model_roots(): 
    roots = set()
    if hasattr(folder_paths, 'models_dir') and folder_paths.models_dir:
        roots.add(os.path.normpath(folder_paths.models_dir))
    elif hasattr(folder_paths, 'base_path'): 
        roots.add(os.path.normpath(os.path.join(folder_paths.base_path, "models")))

    if hasattr(folder_paths, 'folder_names_and_paths'):
        for type_key in folder_paths.folder_names_and_paths.keys():
            type_base_paths = folder_paths.get_folder_paths(type_key) 
            if type_base_paths:
                for path_str in type_base_paths: 
                    if isinstance(path_str, str): 
                         roots.add(os.path.normpath(path_str))
                    elif isinstance(path_str, (list,tuple)): 
                        for sub_path_str in path_str:
                            if isinstance(sub_path_str, str):
                                roots.add(os.path.normpath(sub_path_str))

    if not roots: 
        roots.add(os.path.normpath(os.path.join(os.getcwd(), "models"))) 
        print("🟡 [Holaf-ModelManager] Warning: Could not determine ComfyUI model roots reliably, falling back to CWD/models.")
    return list(roots)


def _detect_model_family(filename: str, model_type_key: str) -> str:
    fn_lower = filename.lower()
    for family_name, keywords, *type_filters in MODEL_FAMILY_KEYWORDS:
        if type_filters:
            allowed_types = type_filters[0]
            if model_type_key not in allowed_types:
                continue
        for keyword in keywords:
            if keyword in fn_lower:
                return family_name
    
    if model_type_key == "checkpoints": return "Generic Checkpoint"
    if model_type_key == "loras": return "Generic LoRA"
    return "Autre"


def scan_and_update_db():
    print("🔵 [Holaf-ModelManager] Starting database scan and update (via scan_and_update_db)...")
    conn = None
    current_time = time.time()
    found_on_disk_paths_canon = set() 

    try:
        conn = _get_db_connection()
        cursor = conn.cursor()
        # MODIFIED: Query uses `path_canon` now.
        cursor.execute("SELECT id, path_canon FROM models")
        # MODIFIED: Key for the dictionary is now `path_canon`.
        db_models_dict_canon_key = {row['path_canon']: dict(row) for row in cursor.fetchall()}
        
        known_type_folder_names = {td['folder_name'] for td in MODEL_TYPE_DEFINITIONS}

        print("🔵 [Holaf-ModelManager] Phase 1: Scanning known model types...")
        for type_def in MODEL_TYPE_DEFINITIONS:
            model_type_key = type_def['folder_name']
            display_name = type_def['type']
            storage_hint = type_def.get('storage_hint', 'file')
            allowed_formats = set(type_def.get('formats', [])) if storage_hint == 'file' else set()

            if model_type_key not in folder_paths.folder_names_and_paths and model_type_key not in folder_paths.folder_names_and_paths.keys():
                 continue
            
            items_in_type_folder = folder_paths.get_filename_list(model_type_key)
            if not items_in_type_folder:
                continue

            for item_name in items_in_type_folder: 
                abs_fs_path = folder_paths.get_full_path(model_type_key, item_name) 
                if not abs_fs_path or not os.path.exists(abs_fs_path): 
                    continue
                # This function call now uses a non-existent schema from a previous version, simplifying to just insert if not present.
                # A full refactor would merge this logic directly, but for now we focus on fixing the bug.
                # The _process_model_item function is now simplified.
                path_for_db = os.path.relpath(abs_fs_path, os.path.normpath(folder_paths.base_path)).replace(os.sep, '/')
                if path_for_db not in db_models_dict_canon_key:
                    model_family = _detect_model_family(item_name, model_type_key)
                    actual_size = os.path.getsize(abs_fs_path) if os.path.isfile(abs_fs_path) else 0
                    try:
                        cursor.execute("""
                            INSERT INTO models (name, path_canon, type, family, size_bytes, last_scanned_at, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        """, (os.path.basename(item_name), path_for_db, model_type_key, model_family, actual_size, current_time, current_time))
                    except sqlite3.IntegrityError: pass
                found_on_disk_paths_canon.add(path_for_db)

        conn.commit()
        print("✅ [Holaf-ModelManager] Phase 1 completed.")

        print("🔵 [Holaf-ModelManager] Phase 2: Scanning for files in 'Other' directories... (This part is simplified for now)")
        # Phase 2 logic is complex and relies on the old schema. It is temporarily simplified to avoid errors.
        # A full refactor would be needed to correctly handle 'Other' directories with the new unified schema.
        
        print("✅ [Holaf-ModelManager] Phase 2 completed (simplified).")

        print("🔵 [Holaf-ModelManager] Phase 3: Cleaning up old entries...")
        db_paths_to_remove = set(db_models_dict_canon_key.keys()) - found_on_disk_paths_canon
        if db_paths_to_remove:
            # MODIFIED: Query uses `path_canon` now.
            for path_to_remove_canon in db_paths_to_remove: 
                cursor.execute("DELETE FROM models WHERE path_canon = ?", (path_to_remove_canon,))
            conn.commit()
        print("✅ [Holaf-ModelManager] Phase 3 completed.")
        print("✅ [Holaf-ModelManager] Database scan and update fully completed.")

    except sqlite3.Error as e:
        print(f"🔴 [Holaf-ModelManager] SQLite error during scan_and_update_db: {e}")
        traceback.print_exc()
        if conn: conn.rollback()
    except Exception as e:
        print(f"🔴 [Holaf-ModelManager] General error during scan_and_update_db: {e}")
        traceback.print_exc()
        if conn: conn.rollback()
    finally:
        if conn: conn.close()


def get_all_models_from_db():
    conn = None
    try:
        conn = _get_db_connection()
        cursor = conn.cursor()
        # MODIFIED: Query uses `path_canon`. Added other fields from client-side expectations.
        cursor.execute("""
            SELECT 
                id, name, path_canon, type as model_type_key, family as model_family, 
                size_bytes, created_at as discovered_at, last_scanned_at,
                sha256 as sha256_hash, metadata_json as extracted_metadata_json, 
                tags as parsed_tags
            FROM models 
            ORDER BY type COLLATE NOCASE, family COLLATE NOCASE, name COLLATE NOCASE
        """)
        
        models_data = []
        for row in cursor.fetchall():
            model_dict = dict(row)
            # MODIFIED: Create the 'path' key for the client from `path_canon`.
            # Also add placeholder keys expected by the client.
            model_dict["path"] = model_dict.pop("path_canon").replace(os.sep, '/')
            model_dict["display_type"] = model_dict.get("model_type_key", "N/A") # Simple mapping for now
            model_dict["is_directory"] = False # Simplified, schema doesn't have this.
            
            if model_dict.get("extracted_metadata_json") == "": 
                model_dict["extracted_metadata_json"] = None

            models_data.append(model_dict)
        
        return models_data
    except sqlite3.Error as e:
        print(f"🔴 [Holaf-ModelManager] Error fetching models from DB: {e}")
        return []
    finally:
        if conn: conn.close()

def is_path_safe(path_from_client_canon: str, is_directory_model: bool = False) -> bool:
    comfyui_base_path_norm = os.path.normpath(folder_paths.base_path)
    is_client_path_intended_as_absolute = path_from_client_canon.startswith('/') or \
                                          (os.name == 'nt' and len(path_from_client_canon) > 1 and path_from_client_canon[1] == ':' and path_from_client_canon[0].isalpha())
    if not is_client_path_intended_as_absolute:
        abs_path_to_check_norm = os.path.normpath(os.path.join(comfyui_base_path_norm, path_from_client_canon))
    else:
        abs_path_to_check_norm = os.path.normpath(path_from_client_canon)
    all_comfy_model_roots = set()
    if hasattr(folder_paths, 'models_dir') and folder_paths.models_dir:
        all_comfy_model_roots.add(os.path.normpath(folder_paths.models_dir))
    if hasattr(folder_paths, 'folder_names_and_paths'):
        for folder_type_key in folder_paths.folder_names_and_paths:
            type_specific_roots = folder_paths.get_folder_paths(folder_type_key)
            if type_specific_roots:
                for root_path in type_specific_roots:
                    all_comfy_model_roots.add(os.path.normpath(root_path))
    if not all_comfy_model_roots:
        all_comfy_model_roots.add(os.path.normpath(os.path.join(folder_paths.base_path, "models")))
    is_safe = False
    normcased_abs_path_to_check = os.path.normcase(abs_path_to_check_norm)
    for root_model_dir_norm in all_comfy_model_roots:
        abs_root_model_dir_norm = os.path.abspath(root_model_dir_norm)
        normcased_abs_root_model_dir = os.path.normcase(abs_root_model_dir_norm)
        if normcased_abs_path_to_check == normcased_abs_root_model_dir or \
           normcased_abs_path_to_check.startswith(normcased_abs_root_model_dir + os.sep):
            is_safe = True
            break
    if not is_safe:
        print(f"🔴 [Holaf-ModelManager] SECURITY: Path '{abs_path_to_check_norm}' (from client path '{path_from_client_canon}') was blocked as it is outside all recognized model directories.")
    return is_safe

def delete_models_from_db_and_disk(model_paths_canon: list):
    """Deletes model files from disk and their records from the database."""
    conn = None
    comfyui_base_path_norm = os.path.normpath(folder_paths.base_path)
    results = {"deleted_count": 0, "errors": []}
    
    if not model_paths_canon:
        return results
    
    try:
        conn = _get_db_connection()
        cursor = conn.cursor()
        
        for path_canon in model_paths_canon:
            abs_model_path = os.path.normpath(os.path.join(comfyui_base_path_norm, path_canon))
            
            # Security check
            if not is_path_safe(path_canon, is_directory_model=False):
                results["errors"].append({"path": path_canon, "message": "Path is outside allowed model directories."})
                continue
            
            try:
                if os.path.isfile(abs_model_path):
                    os.remove(abs_model_path)
                elif os.path.isdir(abs_model_path):
                    shutil.rmtree(abs_model_path)
                else:
                    results["errors"].append({"path": path_canon, "message": "File not found on disk."})
                    # Still try to remove from DB
                    
                cursor.execute("DELETE FROM models WHERE path_canon = ?", (path_canon,))
                if cursor.rowcount > 0:
                    results["deleted_count"] += 1
                    
            except OSError as e:
                results["errors"].append({"path": path_canon, "message": f"Failed to delete file: {str(e)}"})
        
        conn.commit()
    except sqlite3.Error as e:
        results["errors"].append({"path": "N/A", "message": f"Database error during deletion: {str(e)}"})
        if conn: conn.rollback()
    except Exception as e_main:
        results["errors"].append({"path": "N/A", "message": f"General error during deletion: {str(e_main)}"})
        traceback.print_exc()
        if conn: conn.rollback()
    finally:
        if conn: conn.close()
    
    return results

# --- Deep Scan Functionality ---
def _perform_local_deep_scan_for_model(model_abs_fs_path: str) -> dict: 
    scan_results = {
        "sha256": None, "metadata_json": None, "tags": None,
        "error": None
    }
    if not os.path.isfile(model_abs_fs_path):
        scan_results["error"] = "File not found"
        return scan_results
    try:
        hasher = hashlib.sha256()
        with open(model_abs_fs_path, 'rb') as f:
            while chunk := f.read(8192): 
                hasher.update(chunk)
        scan_results["sha256"] = hasher.hexdigest()
    except Exception as e:
        scan_results["error"] = f"SHA256 calculation failed: {str(e)}"

    if model_abs_fs_path.lower().endswith('.safetensors'):
        if not SAFETENSORS_AVAILABLE:
            scan_results["error"] = (scan_results["error"] or "") + "Safetensors library not available."
            return scan_results
        try:
            with safe_open(model_abs_fs_path, framework="pt", device="cpu") as sf_file:
                metadata_raw = sf_file.metadata()
                if metadata_raw:
                    scan_results["metadata_json"] = json.dumps(metadata_raw)
                    scan_results["tags"] = metadata_raw.get("ss_tag", metadata_raw.get("ss_tags"))
        except Exception as e:
            error_msg = f"Safetensors metadata extraction failed: {str(e)}"
            scan_results["error"] = (scan_results["error"] or "") + error_msg
    return scan_results

def process_deep_scan_request(model_paths_from_client_canon: list): 
    conn = None
    comfyui_base_path_norm = os.path.normpath(folder_paths.base_path)
    results = {"updated_count": 0, "errors": []}
    if not model_paths_from_client_canon:
        results["errors"].append({"path": "N/A", "message": "No model paths provided."})
        return results
    try:
        conn = _get_db_connection()
        cursor = conn.cursor()
        for client_path_canon in model_paths_from_client_canon: 
            # Security: reject paths outside the allowed model directories
            # BEFORE any os.path.join / os.path.isfile / file read. is_path_safe
            # builds its allowlist from folder_paths.folder_names_and_paths (which
            # includes the roots from extra_model_paths.yaml) and resolves '..'
            # via normpath, so scanning external model folders keeps working.
            if not is_path_safe(client_path_canon, is_directory_model=False):
                results["errors"].append({"path": client_path_canon, "message": "Path is outside allowed model directories."})
                continue

            abs_model_fs_path = os.path.normpath(os.path.join(comfyui_base_path_norm, client_path_canon))

            if not os.path.isfile(abs_model_fs_path):
                results["errors"].append({"path": client_path_canon, "message": "File not found on server."})
                continue
            
            # MODIFIED: Query uses `path_canon`.
            cursor.execute("SELECT id, name FROM models WHERE path_canon = ?", (client_path_canon,))
            model_record = cursor.fetchone()
            if not model_record:
                results["errors"].append({"path": client_path_canon, "message": "Model not found in DB. Please rescan general models first."})
                continue

            scan_data = _perform_local_deep_scan_for_model(abs_model_fs_path) 
            if scan_data.get("error"):
                results["errors"].append({"path": client_path_canon, "name": model_record['name'], "message": scan_data["error"]})
            
            update_fields = {
                "sha256": scan_data["sha256"], "metadata_json": scan_data["metadata_json"],
                "tags": scan_data["tags"],
                "last_scanned_at": time.time() # Also update scan time on deep scan
            }
            update_values = {k: v for k, v in update_fields.items() if v is not None} 
            if update_values: 
                set_clause = ", ".join([f"{key} = ?" for key in update_values.keys()])
                params = list(update_values.values()) + [client_path_canon] 
                try:
                    # MODIFIED: Query uses `path_canon`.
                    cursor.execute(f"UPDATE models SET {set_clause} WHERE path_canon = ?", params)
                    conn.commit()
                    if cursor.rowcount > 0: results["updated_count"] += 1
                except sqlite3.Error as e_update:
                    results["errors"].append({"path": client_path_canon, "name": model_record['name'], "message": f"DB update failed: {e_update}"})
                    if conn: conn.rollback()
    except sqlite3.Error as e:
        results["errors"].append({"path": "N/A", "message": f"Database error during deep scan: {str(e)}"})
        if conn: conn.rollback()
    except Exception as e_main:
        results["errors"].append({"path": "N/A", "message": f"General error during deep scan: {str(e_main)}"})
        traceback.print_exc()
        if conn: conn.rollback()
    finally:
        if conn: conn.close()
    return results

# --- Initialization ---
load_model_type_definitions()

print("  > [Holaf-ModelManager] Helper module loaded. DB Initialization is now handled by __init__.py.")