# === Holaf Utilities - Image Viewer API Routes (Image Editing) ===
import asyncio
import os
import json
import traceback
import time

import aiofiles
from aiohttp import web
import folder_paths # ComfyUI global

from ... import holaf_utils
from ... import holaf_database
from .. import logic

EDIT_DIR_NAME = "edit"

def _get_edit_paths(output_dir, path_canon):
    """
    Returns a tuple (new_edit_path, legacy_edit_path, edit_dir, safe_path_canon) based on the image path.
    """
    # 1. Resolve absolute path of the image
    safe_path_canon = holaf_utils.sanitize_path_canon(path_canon)
    # Note: path_canon is relative to output_dir

    # Split into directory and filename (relative)
    rel_dir, filename = os.path.split(safe_path_canon)
    base_name, _ = os.path.splitext(filename)

    # Absolute path to the directory containing the image
    abs_img_dir = os.path.normpath(os.path.join(output_dir, rel_dir))

    # Define paths
    edit_filename = f"{base_name}.edt"

    # New Structure: /path/to/image_folder/edit/image.edt
    abs_edit_dir = os.path.join(abs_img_dir, EDIT_DIR_NAME)
    abs_new_edit_path = os.path.join(abs_edit_dir, edit_filename)

    # Legacy Structure: /path/to/image_folder/image.edt
    abs_legacy_edit_path = os.path.join(abs_img_dir, edit_filename)

    return abs_new_edit_path, abs_legacy_edit_path, abs_edit_dir, safe_path_canon

async def load_edits_route(request: web.Request):
    """
    Loads the content of an .edt sidecar file.
    Prioritizes 'edit/' folder, falls back to legacy sibling file.
    """
    path_canon = request.query.get("path_canon")
    if not path_canon:
        return web.json_response({"status": "error", "message": "'path_canon' is required"}, status=400)

    try:
        output_dir = folder_paths.get_output_directory()
        new_path, legacy_path, _, safe_path = _get_edit_paths(output_dir, path_canon)

        if safe_path != path_canon:
             return web.json_response({"status": "error", "message": "Invalid path specified"}, status=403)

        # Security check
        if not new_path.startswith(os.path.normpath(output_dir)):
            return web.json_response({"status": "error", "message": "Forbidden path"}, status=403)

        # Check if the IMAGE (or video) file itself exists
        abs_image_path = os.path.join(output_dir, safe_path)
        if not os.path.isfile(abs_image_path):
             return web.json_response({"status": "error", "message": "Image/Video file not found"}, status=404)

        # Resolve Edits Path
        target_path = None
        if os.path.isfile(new_path):
            target_path = new_path
        elif os.path.isfile(legacy_path):
            target_path = legacy_path

        # --- LOAD EDIT DATA (IF EXISTS) ---
        edit_data = {}
        if target_path:
            async with aiofiles.open(target_path, 'r', encoding='utf-8') as f:
                content = await f.read()
                edit_data = json.loads(content)

        # ── Migration schéma v2 À LA LECTURE (idempotente, sans destruction) ──
        # Un .edt v1 (format plat ou {value, range}) est renvoyé au front déjà
        # normalisé v2 (contrôles tonaux en `zones`, "v": 2 estampillé). Le
        # fichier sur disque n'est pas réécrit ici : la migration s'applique à
        # chaque lecture, et le prochain save persistera le format v2.
        if isinstance(edit_data, dict):
            edit_data = logic._migrate_edit_data(edit_data)

        # ── Masks multiples : renvoyer le PNG de chaque contrôle type 'mask' (data URL) ──
        if isinstance(edit_data, dict):
            controls = edit_data.get('controls') or []
            for ctrl in controls:
                if ctrl.get('type') != 'mask' or not ctrl.get('file'):
                    continue
                try:
                    import base64
                    mask_path = os.path.normpath(
                        os.path.join(os.path.dirname(new_path), os.path.basename(ctrl['file']))
                    )
                    if os.path.isfile(mask_path):
                        with open(mask_path, 'rb') as mf:
                            ctrl['mask_base64'] = 'data:image/png;base64,' + base64.b64encode(mf.read()).decode('ascii')
                except Exception as e:
                    print(f"🟡 [Holaf-Edit] Failed to load mask image: {e}")
            # Retirer l'ancien champ mask unique / mask_base64 de niveau edits
            edit_data.pop('mask', None)
            edit_data.pop('mask_base64', None)

        # --- ENRICH WITH METADATA (FPS & SIDE-LOAD) ---
        response_data = {"status": "ok", "edits": edit_data}

        # Check if video format to inject FPS
        _, ext = os.path.splitext(safe_path)
        if ext.lower() in logic.VIDEO_FORMATS:
            loop = asyncio.get_running_loop()

            # 1. Native FPS
            native_fps = await loop.run_in_executor(None, logic.get_video_fps, abs_image_path)
            response_data["native_fps"] = native_fps

            # 2. Check for Processed Side-Load File (_proc.mp4)
            # Logic module handles the path resolution
            proc_path = logic.get_proc_video_path(abs_image_path)
            if os.path.isfile(proc_path):
                # Construct URL for the frontend to play it
                # We use the standard ComfyUI view route mechanism
                rel_dir = os.path.dirname(safe_path)
                edit_subfolder = os.path.join(rel_dir, EDIT_DIR_NAME).replace("\\", "/")
                proc_filename = os.path.basename(proc_path)

                response_data["processed_video_url"] = f"/view?filename={proc_filename}&subfolder={edit_subfolder}&type=output"

        return web.json_response(response_data)

    except json.JSONDecodeError:
        return web.json_response({"status": "error", "message": "Invalid JSON format in edit file"}, status=500)
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def save_edits_route(request: web.Request):
    """
    Saves edit data to 'edit/' folder.
    Migrates legacy files by deleting them after successful save in new location.
    Forces thumbnail regeneration to reflect changes.
    """
    conn, current_exception = None, None
    try:
        data = await request.json()
        path_canon = data.get("path_canon")
        edits = data.get("edits")

        if not path_canon or edits is None:
            return web.json_response({"status": "error", "message": "'path_canon' and 'edits' are required"}, status=400)

        output_dir = folder_paths.get_output_directory()
        new_path, legacy_path, edit_dir, safe_path = _get_edit_paths(output_dir, path_canon)

        if safe_path != path_canon:
             return web.json_response({"status": "error", "message": "Invalid path specified"}, status=403)

        if not new_path.startswith(os.path.normpath(output_dir)):
            return web.json_response({"status": "error", "message": "Forbidden path"}, status=403)

        # ── Masks multiples : écriture des PNG sidecar pour chaque contrôle type 'mask' ──
        base_name = os.path.splitext(os.path.basename(safe_path))[0]
        mask_layers = data.get('mask_layers') or {}
        if isinstance(edits, dict):
            # Retirer l'ancien champ mask unique (remplacé par les entrées dans controls)
            edits.pop('mask', None)
            edits.pop('mask_base64', None)

            # ── Contrat schéma v2 : normalisation + estampillage "v": 2 avant écriture ──
            # Migration idempotente et sans destruction : un payload v1 reçu du
            # front (value/range ou format plat) est converti en zones ; masks,
            # crop et clés vidéo sont inchangés. Tout .edt écrit porte "v": 2.
            edits = logic._migrate_edit_data(edits)

            controls = edits.get('controls') or []
            active_mask_files = set()
            for ctrl in controls:
                if ctrl.get('type') != 'mask':
                    continue
                ctrl_id = ctrl.get('id')
                data_url = mask_layers.get(ctrl_id)
                if data_url:
                    import base64
                    if ',' in data_url:
                        data_url = data_url.split(',', 1)[1]
                    mask_filename = f"{base_name}_mask_{ctrl_id}.png"
                    mask_abs = os.path.join(os.path.dirname(new_path), mask_filename)
                    with open(mask_abs, 'wb') as mf:
                        mf.write(base64.b64decode(data_url))
                    ctrl['file'] = os.path.join(EDIT_DIR_NAME, mask_filename).replace("\\", "/")
                # Sinon conserver ctrl.file existant
                if ctrl.get('file'):
                    active_mask_files.add(ctrl['file'])

            # Nettoyage : supprimer les PNG mask_<*>_*.png qui ne correspondent plus
            # à aucun contrôle mask actuel
            try:
                for fname in os.listdir(os.path.dirname(new_path)):
                    if fname.startswith(f"{base_name}_mask_") and fname.endswith(".png"):
                        rel = os.path.join(EDIT_DIR_NAME, fname).replace("\\", "/")
                        if rel not in active_mask_files:
                            try:
                                os.remove(os.path.join(os.path.dirname(new_path), fname))
                            except Exception:
                                pass
            except Exception:
                pass
            # Nettoyage de l'ancien mask unique (format pré-refactor)
            try:
                legacy_mask = os.path.join(os.path.dirname(new_path), f"{base_name}_mask.png")
                if os.path.isfile(legacy_mask):
                    os.remove(legacy_mask)
            except Exception:
                pass

        # Ensure 'edit' directory exists
        if not os.path.exists(edit_dir):
            os.makedirs(edit_dir, exist_ok=True)

        # Write the .edt file to the NEW location
        async with aiofiles.open(new_path, 'w', encoding='utf-8') as f:
            await f.write(json.dumps(edits, indent=2))

        # Cleanup: Remove legacy file if it exists to avoid confusion
        if os.path.isfile(legacy_path):
            try:
                os.remove(legacy_path)
                print(f"🔵 [Holaf-Edit] Migrated edit file for {path_canon} to 'edit/' folder.")
            except Exception as e:
                print(f"🟡 [Holaf-Edit] Failed to remove legacy edit file: {e}")

        # Update the database
        conn = holaf_database.get_db_connection()
        cursor = conn.cursor()

        # [MODIFIED] Set thumbnail_status = 0 and high priority to force regeneration
        cursor.execute("""
            UPDATE images
            SET has_edit_file = 1,
                last_synced_at = ?,
                thumbnail_status = 0,
                thumbnail_priority_score = 2000
            WHERE path_canon = ?
        """, (time.time(), path_canon))
        conn.commit()
        holaf_database.close_db_connection()
        conn = None  # Connection is closed, prevent finally block re-closing it.

        # --- FIX: Synchronously regenerate the thumbnail so the frontend gets the updated version ---
        original_abs_path = os.path.normpath(os.path.join(output_dir, safe_path))
        if os.path.isfile(original_abs_path):
            import hashlib
            from ... import holaf_utils
            path_hash = hashlib.sha1(safe_path.encode('utf-8')).hexdigest()
            thumb_filename = f"{path_hash}.jpg"
            thumb_path_abs = os.path.join(holaf_utils.THUMBNAIL_CACHE_DIR, thumb_filename)
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(
                    None,
                    logic._create_thumbnail_blocking,
                    original_abs_path,
                    thumb_path_abs,
                    safe_path,
                    edits
                )
            except Exception as e_thumb:
                print(f"🟡 [Holaf-Edit] Thumbnail regeneration failed (non-fatal): {e_thumb}")

            # ── Invalider le cache navigateur : nouveau thumb_hash ──
            try:
                conn2 = holaf_database.get_db_connection()
                new_hash = hashlib.sha1((safe_path + str(time.time())).encode('utf-8')).hexdigest()[:12]
                cursor2 = conn2.cursor()
                cursor2.execute("UPDATE images SET thumb_hash = ? WHERE path_canon = ?", (new_hash, path_canon))
                conn2.commit()
                holaf_database.close_db_connection()
            except Exception as e:
                print(f"🟡 [Holaf-Edit] thumb_hash update failed: {e}")

        return web.json_response({"status": "ok", "message": "Edits saved successfully"})

    except json.JSONDecodeError:
        current_exception = "Invalid JSON in request"
        return web.json_response({"status": "error", "message": current_exception}, status=400)
    except Exception as e:
        current_exception = e
        traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)
    finally:
        if conn:
            holaf_database.close_db_connection(exception=current_exception)


async def delete_edits_route(request: web.Request):
    """
    Deletes .edt sidecar file (checks both new and legacy locations).
    """
    conn, current_exception = None, None
    try:
        data = await request.json()
        path_canon = data.get("path_canon")
        if not path_canon:
            return web.json_response({"status": "error", "message": "'path_canon' is required"}, status=400)

        output_dir = folder_paths.get_output_directory()
        new_path, legacy_path, _, safe_path = _get_edit_paths(output_dir, path_canon)

        if safe_path != path_canon:
             return web.json_response({"status": "error", "message": "Invalid path specified"}, status=403)

        if not new_path.startswith(os.path.normpath(output_dir)):
            return web.json_response({"status": "error", "message": "Forbidden path"}, status=403)

        # Delete from NEW location
        if os.path.isfile(new_path):
            os.remove(new_path)

        # Delete from LEGACY location (cleanup)
        if os.path.isfile(legacy_path):
            os.remove(legacy_path)

        # Update the database
        conn = holaf_database.get_db_connection()
        cursor = conn.cursor()

        # [MODIFIED] Reset thumbnail too when deleting edits
        cursor.execute("""
            UPDATE images
            SET has_edit_file = 0,
                last_synced_at = ?,
                thumbnail_status = 0,
                thumbnail_priority_score = 2000
            WHERE path_canon = ?
        """, (time.time(), path_canon))

        conn.commit()
        holaf_database.close_db_connection()
        conn = None  # Connection is closed, prevent finally block re-closing it.

        # --- FIX: Synchronously regenerate the thumbnail (without edits) ---
        original_abs_path = os.path.normpath(os.path.join(output_dir, safe_path))
        if os.path.isfile(original_abs_path):
            import hashlib
            from ... import holaf_utils
            path_hash = hashlib.sha1(safe_path.encode('utf-8')).hexdigest()
            thumb_filename = f"{path_hash}.jpg"
            thumb_path_abs = os.path.join(holaf_utils.THUMBNAIL_CACHE_DIR, thumb_filename)
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(
                    None,
                    logic._create_thumbnail_blocking,
                    original_abs_path,
                    thumb_path_abs,
                    safe_path,
                    None  # No edits
                )
            except Exception as e_thumb:
                print(f"🟡 [Holaf-Edit] Thumbnail regeneration failed (non-fatal): {e_thumb}")

        return web.json_response({"status": "ok", "message": "Edits reset successfully"})

    except json.JSONDecodeError:
        current_exception = "Invalid JSON in request"
        return web.json_response({"status": "error", "message": current_exception}, status=400)
    except Exception as e:
        current_exception = e
        traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)
    finally:
        if conn:
            holaf_database.close_db_connection(exception=current_exception)

# --- NEW: SIDE-LOAD PROCESSING ROUTES ---

async def process_video_route(request: web.Request):
    """
    Generates a _proc.mp4 video based on current edits (RIFE, Filters).
    Uses a per-path async lock to prevent concurrent processing of the same video.
    """
    try:
        data = await request.json()
        path_canon = data.get("path_canon")
        edit_data = data.get("edits", {})

        if not path_canon: return web.json_response({"status": "error", "message": "Missing path"}, status=400)

        # FIX: Use a per-path lock to prevent concurrent processing corruption
        from ..logic import _video_processing_locks, _video_processing_locks_mutex
        async with _video_processing_locks_mutex:
            if path_canon not in _video_processing_locks:
                _video_processing_locks[path_canon] = asyncio.Lock()
            path_lock = _video_processing_locks[path_canon]

        if path_lock.locked():
            return web.json_response({"status": "error", "message": "Video is already being processed. Please wait."}, status=409)

        # FIX: Restructured to avoid `return` inside `async with path_lock:`.
        # The old code had cleanup AFTER a `return` (dead code), causing a memory leak
        # in `_video_processing_locks` because the entry was never deleted.
        response = None
        async with path_lock:
            try:
                output_dir = folder_paths.get_output_directory()
                safe_path = holaf_utils.sanitize_path_canon(path_canon)
                abs_image_path = os.path.join(output_dir, safe_path)

                if not os.path.isfile(abs_image_path):
                    response = web.json_response({"status": "error", "message": "Source file not found"}, status=404)
                else:
                    loop = asyncio.get_running_loop()

                    # [UPDATED] Use preview_mode=True to skip baking colors (letting CSS handle it)
                    # and receive stats back
                    stats = await loop.run_in_executor(None, logic.generate_proc_video, abs_image_path, edit_data, True)
                    response = web.json_response({"status": "ok", "message": "Preview generated successfully", "stats": stats})
            except Exception as inner_e:
                response = web.json_response({"status": "error", "message": str(inner_e)}, status=500)

        # Clean up the lock entry after the lock is released (prevents memory leak)
        async with _video_processing_locks_mutex:
            if path_canon in _video_processing_locks and not _video_processing_locks[path_canon].locked():
                del _video_processing_locks[path_canon]

        if response is not None:
            return response
        return web.json_response({"status": "error", "message": "Unknown processing failure"}, status=500)

    except Exception as e:
        traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)

async def rollback_video_route(request: web.Request):
    """
    Deletes the _proc.mp4 video to revert to original view.
    """
    try:
        data = await request.json()
        path_canon = data.get("path_canon")

        output_dir = folder_paths.get_output_directory()
        safe_path = holaf_utils.sanitize_path_canon(path_canon)
        abs_image_path = os.path.join(output_dir, safe_path)

        # Get location of proc file
        proc_path = logic.get_proc_video_path(abs_image_path)

        if os.path.isfile(proc_path):
            os.remove(proc_path)
            return web.json_response({"status": "ok", "message": "Rollback successful"})
        else:
             return web.json_response({"status": "warning", "message": "No processed file found to delete"})

    except Exception as e:
        traceback.print_exc()
        return web.json_response({"status": "error", "message": str(e)}, status=500)