# === Holaf Utilities - Image Viewer Core Logic ===
import os
import hashlib
import json
import math
import time
import datetime
import traceback
import shutil
import sqlite3
import subprocess
import threading
import tempfile
import numpy as np
from PIL import PngImagePlugin, Image, ImageOps, UnidentifiedImageError, ImageEnhance, ImageFilter, ImageFont
import folder_paths

# --- Per-path lock to prevent concurrent video processing of the same file ---
import asyncio
_video_processing_locks = {}
_video_processing_locks_mutex = asyncio.Lock()

# --- Per-thumbnail-file lock registry ---
# Guards the remove -> generate -> serve lifecycle for each distinct thumbnail
# FILE (keyed by the thumbnail FILENAME, e.g. "<thumb_hash>.jpg"). Shared by the
# background thumbnail worker, the inline get_thumbnail_route and the
# regenerate_thumbnail_route so no two generators ever touch the same file
# concurrently. Without this, one generator can os.remove() the file while
# another is between os.path.exists() and web.FileResponse() construction (which
# stats the file), raising FileNotFoundError -> 500 "Failed to read generated
# thumb at final stage.".
# NOTE: The dict grows with the number of distinct thumb files (~32k here) and
# each entry is tiny (a Lock object) — bounded and acceptable.
_thumb_generation_locks = {}
_thumb_generation_locks_mutex = threading.Lock()

def get_thumb_generation_lock(thumb_key):
    """Return the per-thumbnail-file lock for thumb_key (thumbnail FILENAME)."""
    with _thumb_generation_locks_mutex:
        lock = _thumb_generation_locks.get(thumb_key)
        if lock is None:
            lock = _thumb_generation_locks.setdefault(thumb_key, threading.Lock())
        return lock

# --- NEW DEPENDENCY: Required for reading XMP sidecar files for tags ---
try:
    from libxmp.files import XMPFiles
    from libxmp.consts import XMP_NS_DC
    XMP_AVAILABLE = True
except ImportError:
    XMP_AVAILABLE = False
    print("🟡 [Holaf-Logic] Warning: 'python-xmp-toolkit' not found. XMP tag reading will be disabled.")

# Relative imports to sibling modules in the main package
from .. import holaf_database
from .. import holaf_utils
from . import dependency_manager

# --- Constants ---
# MODIFIED: Expanded video format support to ensure FPS detection works for more files
VIDEO_FORMATS = {'.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v'}
AUDIO_FORMATS = {'.wav', '.mp3', '.ogg', '.flac', '.aac', '.m4a'}
SUPPORTED_IMAGE_FORMATS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'}.union(VIDEO_FORMATS).union(AUDIO_FORMATS)

TRASHCAN_DIR_NAME = "trashcan"
EDIT_DIR_NAME = "edit"  # New reserved folder name

STANDARD_RATIOS = [
    {"name": "1:1", "value": 1.0}, {"name": "4:3", "value": 4/3}, {"name": "3:4", "value": 3/4},
    {"name": "3:2", "value": 3/2}, {"name": "2:3", "value": 2/3}, {"name": "16:9", "value": 16/9},
    {"name": "9:16", "value": 9/16}, {"name": "16:10", "value": 16/10}, {"name": "10:16", "value": 10/16},
    {"name": "5:4", "value": 5/4}, {"name": "4:5", "value": 4/5}, {"name": "21:9", "value": 21/9},
    {"name": "9:21", "value": 9/21},
]
RATIO_THRESHOLD = 0.02

# --- ARCHITECTURE CHANGE: IN-MEMORY STATS MANAGER ---
class GlobalStatsManager:
    _instance = None
    _lock = threading.Lock()

    def __init__(self):
        self.total_images = 0
        self.generated_thumbnails = 0
        self.initialized = False

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def initialize_from_db(self):
        """Called once at startup to populate counters from DB.

        Uses a DEDICATED, self-owned connection so it never touches (and thus
        never closes) the shared thread-local connection that other code (e.g.
        routes) may be actively using. This fixes the "Cannot operate on a
        closed database" crash that occurred when this lazy init ran inside
        list_images_route's active query.
        """
        conn = None
        try:
            conn = holaf_database.open_own_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM images WHERE is_trashed = 0")
            self.total_images = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM images WHERE thumbnail_status = 2 AND is_trashed = 0")
            self.generated_thumbnails = cursor.fetchone()[0]
            self.initialized = True
            print(f"🔵 [Holaf-Stats] Stats initialized: {self.total_images} images, {self.generated_thumbnails} thumbnails.")
        except Exception as e:
            print(f"🔴 [Holaf-Stats] Failed to initialize stats: {e}")
        finally:
            # Only close our OWN dedicated connection. Never touch the shared
            # thread-local one (close_db_connection() is deliberately not used).
            holaf_database.close_own_connection(conn)

    def increment_total(self):
        with self._lock: self.total_images += 1

    def decrement_total(self):
        with self._lock: 
            if self.total_images > 0: self.total_images -= 1

    def increment_thumbnail(self):
        with self._lock: self.generated_thumbnails += 1
    
    # Note: We rarely decrement thumbnails individually, usually mass reset via SQL which requires re-init.

    def get_stats(self):
        if not self.initialized:
            self.initialize_from_db()
        return {
            "total_db_count": self.total_images,
            "generated_thumbnails_count": self.generated_thumbnails
        }
    
    def force_refresh(self):
        self.initialize_from_db()

# Global Accessor
stats_manager = GlobalStatsManager.get_instance()

# --- MODIFICATION START: Live Update Tracking ---
LAST_DB_UPDATE_TIME = time.time()

def update_last_db_update_time():
    """Updates the global timestamp to signal a database change."""
    global LAST_DB_UPDATE_TIME
    LAST_DB_UPDATE_TIME = time.time()
# --- MODIFICATION END ---


# --- Filesystem Helpers ---
_trashcan_ensured = False

def ensure_trashcan_exists():
    """Ensures the trashcan directory exists within the main output directory."""
    global _trashcan_ensured
    if _trashcan_ensured:
        trashcan_path = os.path.join(folder_paths.get_output_directory(), TRASHCAN_DIR_NAME)
        return trashcan_path if os.path.exists(trashcan_path) else None
    
    try:
        output_dir = folder_paths.get_output_directory()
        trashcan_path = os.path.join(output_dir, TRASHCAN_DIR_NAME)
        if not os.path.exists(trashcan_path):
            try:
                os.makedirs(trashcan_path, exist_ok=True)
            except OSError as e:
                print(f"🔴 [Holaf-ImageViewer] Failed to create trashcan directory {trashcan_path}: {e}")
                return None
        _trashcan_ensured = True
        return trashcan_path
    except Exception:
        # folder_paths may not be initialized yet — will try again on next call
        return None

def get_ffmpeg_path():
    """Returns the path to the ffmpeg executable, or None if not found."""
    return shutil.which("ffmpeg")

def get_ffprobe_path():
    """Returns the path to the ffprobe executable, or None if not found."""
    return shutil.which("ffprobe")

def get_proc_video_path(original_abs_path):
    """
    Returns the absolute path where the processed preview video (_proc.mp4) should be stored.
    It is stored in the 'edit' subfolder next to the original file.
    """
    directory, filename = os.path.split(original_abs_path)
    base_name, _ = os.path.splitext(filename)
    edit_dir = os.path.join(directory, EDIT_DIR_NAME)
    if not os.path.exists(edit_dir):
        os.makedirs(edit_dir, exist_ok=True)
    return os.path.join(edit_dir, f"{base_name}_proc.mp4")

# --- NEW HELPER FOR FPS ---
def get_video_fps(video_path):
    """
    Uses ffprobe to extract the exact frame rate of a video.
    Returns a float (e.g. 23.976, 30.0, 60.0). Returns 30.0 on failure.
    """
    ffprobe = get_ffprobe_path()
    if not ffprobe:
        return 30.0
        
    try:
        # Command to get e.g., "30000/1001" or "30/1"
        cmd = [
            ffprobe, "-v", "0", "-of", "csv=p=0", 
            "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", 
            video_path
        ]
        
        # Run with timeout to avoid hanging
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            return 30.0
            
        if process.returncode == 0:
            rate_str = stdout.decode('utf-8').strip()
            if '/' in rate_str:
                num, den = rate_str.split('/')
                if float(den) > 0:
                    return float(num) / float(den)
            elif rate_str:
                return float(rate_str)
                
        return 30.0
    except Exception as e:
        print(f"🟡 [Holaf-Logic] Failed to extract FPS for {video_path}: {e}")
        return 30.0

def _update_folder_metadata_cache_blocking(cursor):
    """
    Clears and completely rebuilds the folder_metadata table.
    This should be called within an existing DB transaction.
    """
    try:
        current_time = time.time()
        
        cursor.execute("DELETE FROM folder_metadata")
        
        # FIX: Group by top_level_subfolder to match the filter-options API query,
        # instead of the full subfolder path which created an inconsistent cache.
        cursor.execute("""
            INSERT INTO folder_metadata (path_canon, image_count, last_calculated_at)
            SELECT 
                top_level_subfolder AS folder_path,
                COUNT(*) as count,
                ?
            FROM images
            WHERE is_trashed = 0
            GROUP BY top_level_subfolder
        """, (current_time,))
        
    except Exception as e:
        print(f"🔴 [Holaf-Logic] CRITICAL: Failed to rebuild folder metadata cache: {e}")
        raise


def _increment_folder_count(cursor, folder_path):
    """Incrementally increases the image count for a folder."""
    cursor.execute("""
        INSERT INTO folder_metadata (path_canon, image_count, last_calculated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(path_canon) DO UPDATE SET
            image_count = image_count + 1,
            last_calculated_at = ?
    """, (folder_path, time.time(), time.time()))


def _decrement_folder_count(cursor, folder_path):
    """Incrementally decreases the image count for a folder."""
    cursor.execute("""
        UPDATE folder_metadata
        SET image_count = MAX(0, image_count - 1), last_calculated_at = ?
        WHERE path_canon = ?
    """, (time.time(), folder_path))


def _update_image_tags_in_db(cursor, image_id, tags_list):
    """
    Updates the tags for a specific image ID within a transaction.
    It clears existing tags and adds the new ones.
    """
    cursor.execute("DELETE FROM imagetags WHERE image_id = ?", (image_id,))

    if not tags_list:
        return 

    for tag_name in set(tags_list): 
        if not isinstance(tag_name, str) or not tag_name.strip():
            continue 
        
        clean_tag = tag_name.strip().lower()

        cursor.execute("SELECT tag_id FROM tags WHERE name = ?", (clean_tag,))
        tag_row = cursor.fetchone()
        
        if tag_row:
            tag_id = tag_row['tag_id']
        else:
            cursor.execute("INSERT INTO tags (name) VALUES (?)", (clean_tag,))
            tag_id = cursor.lastrowid
        
        cursor.execute("INSERT OR IGNORE INTO imagetags (image_id, tag_id) VALUES (?, ?)", (image_id, tag_id))

# --- Database Synchronization ---

def add_or_update_single_image(image_abs_path, _attempts=1):
    """
    Efficiently adds or updates a single image in the database.
    """
    output_dir = folder_paths.get_output_directory()
    if not os.path.normpath(image_abs_path).startswith(os.path.normpath(output_dir)):
        return

    conn = None
    update_exception = None
    try:
        try:
            file_stat = os.stat(image_abs_path)
        except FileNotFoundError:
            return

        directory, filename = os.path.split(image_abs_path)
        base_filename, file_ext = os.path.splitext(filename)

        if file_ext.lower() not in SUPPORTED_IMAGE_FORMATS:
            return

        subfolder_str = os.path.relpath(directory, output_dir).replace(os.sep, '/')
        if subfolder_str == '.': subfolder_str = ''
        path_canon = os.path.join(subfolder_str, filename).replace('\\', '/')
        
        thumb_hash = hashlib.sha1(path_canon.encode('utf-8')).hexdigest()

        # Check exclusion for Trashcan AND Edit folder
        if (subfolder_str.startswith(TRASHCAN_DIR_NAME + '/') or subfolder_str == TRASHCAN_DIR_NAME or
            subfolder_str.endswith('/' + EDIT_DIR_NAME) or subfolder_str == EDIT_DIR_NAME or f"/{EDIT_DIR_NAME}/" in subfolder_str):
            return

        top_level_subfolder = 'root'
        if subfolder_str:
            top_level_subfolder = subfolder_str.split('/')[0]

        meta = _extract_image_metadata_blocking(image_abs_path)

        # FIX: Audio files have width=0, height=0 (valid). Video files without
        # ffprobe have width=None, height=None. Only block genuine image failures.
        is_audio = meta.get('is_audio', False) or meta.get('ratio') == 'audio'
        width_val = meta.get('width')
        height_val = meta.get('height')
        has_valid_dims = (width_val is not None and width_val > 0 and
                          height_val is not None and height_val > 0)
        if not is_audio and not has_valid_dims:
            print(f"🔴 [Holaf-Logic] CRITICAL: Failed to extract valid metadata for {path_canon}. Aborting DB insertion.")
            return

        has_prompt_flag = (meta.get('prompt_source', 'none') not in ['none', 'error'])
        has_workflow_flag = (meta.get('workflow_source', 'none') not in ['none', 'error'])
        has_edits_flag = meta.get('has_edits', False)
        has_edit_file = has_edits_flag
        
        tags_list = meta.get('tags', [])
        has_tags_flag = bool(tags_list)

        conn = holaf_database.get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("SELECT id, is_trashed FROM images WHERE path_canon = ?", (path_canon,))
        existing_image = cursor.fetchone()

        if existing_image:
            image_id = existing_image['id']
            was_trashed = existing_image['is_trashed']
            cursor.execute("""
                UPDATE images SET
                    filename=?, subfolder=?, top_level_subfolder=?, format=?, mtime=?, size_bytes=?, last_synced_at=?,
                    is_trashed=0, original_path_canon=NULL, prompt_text=?, workflow_json=?, prompt_source=?,
                    workflow_source=?, width=?, height=?, aspect_ratio_str=?, has_edit_file=?, thumb_hash=?,
                    has_prompt=?, has_workflow=?, has_edits=?, has_tags=?, thumbnail_status=0, thumbnail_priority_score=1000, thumbnail_last_generated_at=NULL
                WHERE id=?
            """, (filename, subfolder_str, top_level_subfolder, file_ext[1:].upper(), file_stat.st_mtime, file_stat.st_size, time.time(),
                  meta.get('prompt'), json.dumps(meta.get('workflow')) if meta.get('workflow') else None, meta.get('prompt_source'),
                  meta.get('workflow_source'), meta.get('width'), meta.get('height'), meta.get('ratio'), has_edit_file, thumb_hash,
                  has_prompt_flag, has_workflow_flag, has_edits_flag, has_tags_flag, image_id))
        else:
            cursor.execute("""
                INSERT INTO images 
                    (filename, subfolder, top_level_subfolder, path_canon, format, mtime, size_bytes, last_synced_at, 
                    is_trashed, original_path_canon, prompt_text, workflow_json, prompt_source, workflow_source,
                    width, height, aspect_ratio_str, has_edit_file, thumb_hash, has_prompt, has_workflow, has_edits, has_tags,
                    thumbnail_status, thumbnail_priority_score, thumbnail_last_generated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1000, NULL)
            """, (filename, subfolder_str, top_level_subfolder, path_canon, file_ext[1:].upper(),
                  file_stat.st_mtime, file_stat.st_size, time.time(),
                  meta.get('prompt'), json.dumps(meta.get('workflow')) if meta.get('workflow') else None,
                  meta.get('prompt_source'), meta.get('workflow_source'),
                  meta.get('width'), meta.get('height'), meta.get('ratio'), has_edit_file, thumb_hash,
                  has_prompt_flag, has_workflow_flag, has_edits_flag, has_tags_flag))
            image_id = cursor.lastrowid
            
            # --- NOTIFY STATS ---
            stats_manager.increment_total()
        
        _update_image_tags_in_db(cursor, image_id, tags_list)
        # Incremental folder count update (not full rebuild)
        if existing_image:
            if was_trashed:
                _increment_folder_count(cursor, top_level_subfolder)
        else:
            _increment_folder_count(cursor, top_level_subfolder)
        conn.commit()
        print(f"✅ [Holaf-Logic-DB] Successfully added/updated in DB: {path_canon}")
        update_last_db_update_time() 

    except Exception as e:
        update_exception = e
        print(f"🔴 [Holaf-Logic] Error in add_or_update_single_image for {image_abs_path}: {e}")
        traceback.print_exc()
        # Retry transient DB-lock failures: a silent failure here would leave the
        # image invisible until the next periodic sync (minutes).
        if _attempts < 3 and isinstance(e, sqlite3.OperationalError):
            time.sleep(0.5)
            return add_or_update_single_image(image_abs_path, _attempts + 1)
    finally:
        if conn:
            holaf_database.close_db_connection(exception=update_exception)

def delete_single_image_by_path(image_abs_path):
    output_dir = folder_paths.get_output_directory()
    if not os.path.normpath(image_abs_path).startswith(os.path.normpath(output_dir)):
        return
    conn = None
    delete_exception = None
    try:
        directory, filename = os.path.split(image_abs_path)
        subfolder_str = os.path.relpath(directory, output_dir).replace(os.sep, '/')
        if subfolder_str == '.': subfolder_str = ''
        path_canon = os.path.join(subfolder_str, filename).replace('\\', '/')
        conn = holaf_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, is_trashed, top_level_subfolder FROM images WHERE path_canon = ?", (path_canon,))
        image_row = cursor.fetchone()
        if image_row:
            if not image_row['is_trashed']:
                _decrement_folder_count(cursor, image_row['top_level_subfolder'])
            cursor.execute("DELETE FROM images WHERE path_canon = ?", (path_canon,))
            conn.commit()
            print(f"✅ [Holaf-Logic-DB] Successfully deleted from DB: {path_canon}")
            update_last_db_update_time()
            
            # --- NOTIFY STATS ---
            stats_manager.decrement_total()
            
    except Exception as e:
        delete_exception = e
        print(f"🔴 [Holaf-Logic] Error in delete_single_image_by_path for {image_abs_path}: {e}")
        traceback.print_exc()
    finally:
        if conn:
            holaf_database.close_db_connection(exception=delete_exception)


def sync_image_database_blocking():
    print("🔵 [Holaf-ImageViewer] Starting periodic image database synchronization...")
    output_dir = folder_paths.get_output_directory()
    trashcan_full_path = os.path.join(output_dir, TRASHCAN_DIR_NAME)
    current_time = time.time()
    conn = None
    sync_exception = None

    # --- SAFETY: if the output directory is missing or unreadable, bail out
    # WITHOUT cleaning stale entries. Otherwise the os.walk branch below is
    # skipped, disk_images_canons stays empty, and every non-trashed DB record
    # would be treated as stale and purged (along with its thumbnails). A
    # transient episode (unmounted network mount, sleeping disk, bad config)
    # must not wipe the whole database. Keep the existing state untouched.
    if not os.path.isdir(output_dir) or not os.access(output_dir, os.R_OK):
        print(f"🟡 [Holaf-ImageViewer] Output directory missing or unreadable ({output_dir}); "
              f"skipping sync and preserving existing database state.")
        return

    # --- BATCH OPTIMIZATION CONFIG ---
    BATCH_SIZE = 50 # Commit to DB every 50 operations to release write lock for UI interactions
    ops_counter = 0
    added_count = 0
    deleted_count = 0
    changed_count = 0

    try:
        conn = holaf_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, path_canon, mtime, size_bytes, thumbnail_last_generated_at, thumb_hash FROM images WHERE is_trashed = 0")
        db_images = {row['path_canon']: dict(row) for row in cursor.fetchall()}
        disk_images_canons = set()
        if not os.path.isdir(output_dir):
            print(f"🟡 [Holaf-ImageViewer] Output directory not found: {output_dir}")
        else:
            for root, dirs, files in os.walk(output_dir):
                # --- IGNORE TRASHCAN ---
                if os.path.normpath(root) == os.path.normpath(trashcan_full_path):
                    dirs[:] = [] 
                    continue
                if os.path.normpath(root).startswith(os.path.normpath(trashcan_full_path) + os.sep):
                    continue

                # --- IGNORE EDIT FOLDERS ---
                if EDIT_DIR_NAME in dirs:
                    dirs.remove(EDIT_DIR_NAME)
                
                if os.path.basename(root) == EDIT_DIR_NAME:
                    continue

                for filename in files:
                    file_ext = os.path.splitext(filename)[1].lower()
                    if file_ext not in SUPPORTED_IMAGE_FORMATS:
                        continue
                    try:
                        full_path = os.path.join(root, filename)
                        file_stat = os.stat(full_path)
                        subfolder_str = os.path.relpath(root, output_dir).replace(os.sep, '/')
                        if subfolder_str == '.': subfolder_str = ''
                        
                        if subfolder_str.startswith(TRASHCAN_DIR_NAME + '/') or subfolder_str == TRASHCAN_DIR_NAME:
                            continue

                        path_canon = os.path.join(subfolder_str, filename).replace('\\', '/')
                        thumb_hash = hashlib.sha1(path_canon.encode('utf-8')).hexdigest()
                        
                        disk_images_canons.add(path_canon)
                        top_level_subfolder = 'root'
                        if subfolder_str: top_level_subfolder = subfolder_str.split('/')[0]

                        # --- ONLY PROCESS IF CHANGED OR NEW ---
                        existing_record = db_images.get(path_canon)
                        should_process = False
                        
                        if not existing_record:
                            should_process = True
                        elif (existing_record['mtime'] != file_stat.st_mtime or
                              existing_record['size_bytes'] != file_stat.st_size or
                              existing_record.get('thumb_hash') != thumb_hash):
                            should_process = True
                            
                        if should_process:
                            # Only extract metadata if we actually need to write to DB
                            meta = _extract_image_metadata_blocking(full_path)
                            has_prompt_flag = (meta.get('prompt_source', 'none') not in ['none', 'error'])
                            has_workflow_flag = (meta.get('workflow_source', 'none') not in ['none', 'error'])
                            has_edits_flag = meta.get('has_edits', False)
                            has_edit_file = has_edits_flag
                            
                            tags_list = meta.get('tags', [])
                            has_tags_flag = bool(tags_list)
                            
                            image_id = None
                            if existing_record:
                                image_id = existing_record['id']
                                cursor.execute("""
                                    UPDATE images SET mtime=?, size_bytes=?, last_synced_at=?, subfolder=?, 
                                    top_level_subfolder=?, prompt_text=?, workflow_json=?, prompt_source=?, 
                                    workflow_source=?, width=?, height=?, aspect_ratio_str=?, has_edit_file=?, thumb_hash=?,
                                    has_prompt=?, has_workflow=?, has_edits=?, has_tags=?, 
                                    thumbnail_status=0, thumbnail_priority_score=1000, thumbnail_last_generated_at=NULL
                                    WHERE id=?
                                """, (file_stat.st_mtime, file_stat.st_size, current_time, subfolder_str, top_level_subfolder,
                                      meta.get('prompt'), json.dumps(meta.get('workflow')) if meta.get('workflow') else None, meta.get('prompt_source'),
                                      meta.get('workflow_source'), meta.get('width'), meta.get('height'), meta.get('ratio'), has_edit_file, thumb_hash,
                                      has_prompt_flag, has_workflow_flag, has_edits_flag, has_tags_flag, image_id))
                                changed_count += 1
                            else:
                                cursor.execute("""
                                    INSERT INTO images (filename, subfolder, top_level_subfolder, path_canon, format, mtime, 
                                    size_bytes, last_synced_at, has_edit_file, thumb_hash, has_prompt, has_workflow, has_edits, has_tags,
                                    prompt_text, workflow_json, prompt_source, workflow_source, width, height, aspect_ratio_str,
                                    thumbnail_status, thumbnail_priority_score, thumbnail_last_generated_at)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                                """, (filename, subfolder_str, top_level_subfolder, path_canon, file_ext[1:].upper(),
                                      file_stat.st_mtime, file_stat.st_size, current_time, has_edit_file, thumb_hash,
                                      has_prompt_flag, has_workflow_flag, has_edits_flag, has_tags_flag,
                                      meta.get('prompt'), json.dumps(meta.get('workflow')) if meta.get('workflow') else None,
                                      meta.get('prompt_source'), meta.get('workflow_source'),
                                      meta.get('width'), meta.get('height'), meta.get('ratio'),
                                      0, 1000, None))
                                image_id = cursor.lastrowid
                                added_count += 1
                            
                            if image_id:
                                _update_image_tags_in_db(cursor, image_id, tags_list)
                            
                            # --- BATCH COMMIT LOGIC ---
                            ops_counter += 1
                            if ops_counter >= BATCH_SIZE:
                                conn.commit() # Release lock
                                ops_counter = 0
                                # Small sleep to let other threads grab the lock if needed
                                time.sleep(0.01) 
                                
                    except Exception as e:
                        print(f"🔴 [Holaf-ImageViewer] Error processing file {filename} during sync: {e}")
            
            # Final commit for remaining updates
            conn.commit()

        stale_canons = set(db_images.keys()) - disk_images_canons
        if stale_canons:
            deleted_count = len(stale_canons)
            print(f"🔵 [Holaf-ImageViewer] Found {len(stale_canons)} stale image entries to remove from DB.")
            
            # Delete orphan thumbnail files before removing DB entries
            thumb_dir = holaf_utils.THUMBNAIL_CACHE_DIR
            for canon in stale_canons:
                thumb_hash = db_images[canon].get('thumb_hash')
                if thumb_hash:
                    thumb_path = os.path.join(thumb_dir, f"{thumb_hash}.jpg")
                    if os.path.exists(thumb_path):
                        try: os.remove(thumb_path)
                        except OSError: pass
            
            placeholders = ','.join('?' for _ in stale_canons)
            cursor.execute(f"DELETE FROM images WHERE path_canon IN ({placeholders}) AND is_trashed = 0", tuple(stale_canons))
            conn.commit()
        
        # Only rebuild the folder metadata cache and bump the DB update timestamp
        # when this pass actually detected changes. Otherwise (the common case,
        # e.g. no new/removed/modified files) we leave both untouched so the
        # frontend's polling does NOT trigger a full 30k-image re-fetch every pass.
        detected_changes = (added_count > 0) or (deleted_count > 0) or (changed_count > 0)

        if detected_changes:
            _update_folder_metadata_cache_blocking(cursor)
            conn.commit()

        # --- REFRESH GLOBAL STATS ---
        # Since sync is massive, we just force a refresh at the end (only when changed)
        if detected_changes:
            stats_manager.force_refresh()

        print("✅ [Holaf-ImageViewer] Periodic image database synchronization complete.")
        if detected_changes:
            update_last_db_update_time()
    except Exception as e:
        sync_exception = e
        print(f"🔴 [Holaf-ImageViewer] Error during sync: {e}")
        traceback.print_exc()
    finally:
        if conn:
            holaf_database.close_db_connection(exception=sync_exception)


def clean_thumbnails_blocking():
    """
    Scans the thumbnail directory and the database to clean up and regenerate thumbnails.
    """
    print("🔵 [Holaf-ImageViewer] Starting thumbnail cleaning process...")
    thumb_dir = holaf_utils.THUMBNAIL_CACHE_DIR
    
    deleted_orphans_count = 0
    regenerated_missing_count = 0
    regenerated_corrupt_count = 0
    
    conn = None
    clean_exception = None

    try:
        conn = holaf_database.get_db_connection()
        cursor = conn.cursor()

        if os.path.isdir(thumb_dir):
            all_thumb_files = os.listdir(thumb_dir)
            cursor.execute("SELECT thumb_hash FROM images WHERE thumb_hash IS NOT NULL")
            valid_hashes = {row['thumb_hash'] for row in cursor.fetchall()}
            
            for thumb_filename in all_thumb_files:
                thumb_hash = os.path.splitext(thumb_filename)[0]
                
                if thumb_hash not in valid_hashes:
                    try:
                        os.remove(os.path.join(thumb_dir, thumb_filename))
                        deleted_orphans_count += 1
                    except OSError as e:
                        print(f"🟡 [Holaf-ImageViewer] Could not delete orphan thumbnail {thumb_filename}: {e}")

        cursor.execute("SELECT id, path_canon, thumb_hash FROM images WHERE thumbnail_status != 3")
        images_to_check = cursor.fetchall()
        
        ids_to_reset_missing = []
        ids_to_reset_corrupt = []

        for image in images_to_check:
            if not image['thumb_hash']: continue 

            thumb_filename = f"{image['thumb_hash']}.jpg"
            thumb_path = os.path.join(thumb_dir, thumb_filename)
            
            if not os.path.exists(thumb_path):
                ids_to_reset_missing.append(image['id'])
            else:
                try:
                    with Image.open(thumb_path) as img:
                        img.verify() 
                except Exception:
                    ids_to_reset_corrupt.append(image['id'])

        if ids_to_reset_missing:
            regenerated_missing_count = len(ids_to_reset_missing)
            cursor.execute(f"UPDATE images SET thumbnail_status = 0, thumbnail_priority_score = 1500 WHERE id IN ({','.join(['?']*len(ids_to_reset_missing))})", ids_to_reset_missing)
            print(f"🔵 [Holaf-ImageViewer] Marked {regenerated_missing_count} images for thumbnail regeneration (missing).")

        if ids_to_reset_corrupt:
            regenerated_corrupt_count = len(ids_to_reset_corrupt)
            cursor.execute(f"UPDATE images SET thumbnail_status = 0, thumbnail_priority_score = 1500 WHERE id IN ({','.join(['?']*len(ids_to_reset_corrupt))})", ids_to_reset_corrupt)
            print(f"🔵 [Holaf-ImageViewer] Marked {regenerated_corrupt_count} images for thumbnail regeneration (corrupt).")

        conn.commit()

        # --- REFRESH GLOBAL STATS ---
        stats_manager.force_refresh()

        print(f"✅ [Holaf-ImageViewer] Thumbnail cleaning complete. "
                f"Deleted: {deleted_orphans_count}, "
                f"Queued for regen (missing): {regenerated_missing_count}, "
                f"Queued for regen (corrupt): {regenerated_corrupt_count}.")
        
        return {
            "deleted_orphans": deleted_orphans_count,
            "regenerated_missing": regenerated_missing_count,
            "regenerated_corrupt": regenerated_corrupt_count
        }

    except Exception as e:
        clean_exception = e
        print(f"🔴 [Holaf-ImageViewer] Error during thumbnail cleaning: {e}")
        traceback.print_exc()
        return {"error": str(e)}
    finally:
        if conn:
            holaf_database.close_db_connection(exception=clean_exception)


# --- Metadata Extraction ---
def _sanitize_json_nan(obj):
    if isinstance(obj, dict): return {k: _sanitize_json_nan(v) for k, v in obj.items()}
    elif isinstance(obj, list): return [_sanitize_json_nan(i) for i in obj]
    elif (isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj))): return None
    return obj

def _get_best_ratio_string(width, height):
    if height == 0: return None
    actual_ratio = width / height
    min_diff, best_match = float('inf'), None
    for r_info in STANDARD_RATIOS:
        diff = abs(actual_ratio - r_info["value"])
        if diff < min_diff: min_diff, best_match = diff, r_info["name"]
    if min_diff / actual_ratio < RATIO_THRESHOLD: return best_match
    common_divisor = math.gcd(width, height)
    return f"{width // common_divisor}:{height // common_divisor}"

def _extract_image_metadata_blocking(image_path_abs):
    directory, filename = os.path.split(image_path_abs)
    base_filename, file_ext = os.path.splitext(filename)

    prompt_txt_path = os.path.join(directory, base_filename + ".txt")
    workflow_json_path = os.path.join(directory, base_filename + ".json")
    xmp_file_path = os.path.join(directory, base_filename + ".xmp")
    
    # --- MODIFICATION: Updated Edit File Logic ---
    # Check new folder structure first
    new_edit_path = os.path.join(directory, EDIT_DIR_NAME, base_filename + ".edt")
    legacy_edit_path = os.path.join(directory, base_filename + ".edt")
    
    has_edits = False
    if os.path.isfile(new_edit_path):
        has_edits = True
    elif os.path.isfile(legacy_edit_path):
        has_edits = True
    # ---------------------------------------------

    result = {
        "prompt": None, "prompt_source": "none",
        "workflow": None, "workflow_source": "none",
        "width": None, "height": None, "ratio": None,
        "has_edits": has_edits,
        "tags": [] 
    }

    if XMP_AVAILABLE and os.path.isfile(xmp_file_path):
        try:
            xmpfile = XMPFiles(file_path=xmp_file_path, open_forupdate=False)
            xmp = xmpfile.get_xmp()
            if xmp and xmp.does_property_exist(XMP_NS_DC, 'subject'):
                tags = xmp.get_property(XMP_NS_DC, 'subject')
                if tags:
                    result["tags"] = [str(tag) for tag in tags if isinstance(tag, str) and tag.strip()]
            xmpfile.close_file()
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Failed to read XMP file {xmp_file_path}: {e}")

    if os.path.isfile(prompt_txt_path):
        try:
            with open(prompt_txt_path, 'r', encoding='utf-8') as f: result["prompt"] = f.read()
            result["prompt_source"] = "external_txt"
        except Exception as e: result["prompt"], result["prompt_source"] = f"Error reading .txt: {e}", "error"

    if os.path.isfile(workflow_json_path):
        try:
            with open(workflow_json_path, 'r', encoding='utf-8') as f: result["workflow"] = _sanitize_json_nan(json.load(f))
            result["workflow_source"] = "external_json"
        except Exception as e: result["workflow"], result["workflow_source"] = {"error": f"Error reading .json: {e}"}, "error"

    if file_ext.lower() in VIDEO_FORMATS:
        ffprobe = get_ffprobe_path()
        if ffprobe:
            try:
                cmd = [
                    ffprobe, "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "stream=width,height",
                    "-of", "json", image_path_abs
                ]
                
                # --- PROTECTION TIMEOUT ADDED ---
                process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate()
                    raise RuntimeError("ffprobe timed out")
                # --------------------------------
                
                if process.returncode == 0:
                    info = json.loads(stdout)
                    streams = info.get("streams", [])
                    if streams:
                        result["width"] = streams[0].get("width")
                        result["height"] = streams[0].get("height")
                        if result["width"] and result["height"]:
                             result["ratio"] = _get_best_ratio_string(result["width"], result["height"])
                else:
                    result["error"] = f"ffprobe failed: {stderr.decode('utf-8')}"
            except Exception as e:
                result["error"] = f"Video analysis failed: {e}"
        else:
            result["error"] = "ffprobe not found"
            
        return result

    # --- AUDIO FORMAT HANDLING ---
    if file_ext.lower() in AUDIO_FORMATS:
        ffprobe = get_ffprobe_path()
        if ffprobe:
            try:
                # Extract duration for audio files
                cmd = [
                    ffprobe, "-v", "error", "-show_entries", "format=duration",
                    "-show_entries", "stream=codec_name,sample_rate,channels",
                    "-of", "json", image_path_abs
                ]
                process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate()
                    raise RuntimeError("ffprobe timed out")
                
                if process.returncode == 0:
                    info = json.loads(stdout)
                    streams = info.get("streams", [])
                    fmt_info = info.get("format", {})
                    
                    # Store audio-specific metadata
                    duration_secs = float(fmt_info.get("duration", 0))
                    result["duration"] = duration_secs
                    result["width"] = 0    # Audio has no visual dimensions
                    result["height"] = 0
                    result["ratio"] = "audio"
                    result["is_audio"] = True
                    
                    if streams:
                        stream = streams[0]
                        result["audio_codec"] = stream.get("codec_name", "unknown")
                        result["audio_sample_rate"] = stream.get("sample_rate", "unknown")
                        result["audio_channels"] = stream.get("channels", "unknown")
                else:
                    result["error"] = f"ffprobe failed: {stderr.decode('utf-8')}"
            except Exception as e:
                result["error"] = f"Audio analysis failed: {e}"
        else:
            result["error"] = "ffprobe not found"
            result["width"] = 0
            result["height"] = 0
            result["ratio"] = "audio"
            result["is_audio"] = True
        
        return result

    # FIX: Temporarily disable Pillow's decompression bomb limit.
    # We only read metadata (dimensions, prompts) — no pixel decompression occurs.
    # Legitimate AI images can exceed the 178M pixel threshold.
    old_max_pixels = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(image_path_abs) as img:
            result["width"], result["height"] = img.size
            if result["width"] and result["height"]: result["ratio"] = _get_best_ratio_string(result["width"], result["height"])
            if hasattr(img, 'info') and isinstance(img.info, dict):
                if result["prompt_source"] == "none" and 'prompt' in img.info:
                    result["prompt"], result["prompt_source"] = img.info['prompt'], "internal_png"
                if result["workflow_source"] == "none" and 'workflow' in img.info:
                    try:
                        result["workflow"], result["workflow_source"] = _sanitize_json_nan(json.loads(img.info['workflow'])), "internal_png"
                    except Exception: result["workflow"], result["workflow_source"] = {"error": "Malformed workflow in PNG"}, "error"
    except FileNotFoundError: result["error"] = "Image file not found"
    except UnidentifiedImageError: result["error"] = "Unidentified image error"
    except Exception as e: result["error"] = str(e)
    finally:
        Image.MAX_IMAGE_PIXELS = old_max_pixels
    if "error" in result: print(f"🟡 [Holaf-Logic] Metadata error for {filename}: {result['error']}")

    return result

def _get_luminance_mask(image, range_type):
    """
    Creates a smooth luminance mask for the given range type.
    Returns a PIL.Image in 'L' mode (0=transparent, 255=opaque).
    Returns None if range_type is None or 'all' (no masking).
    """
    if not range_type or range_type == 'all':
        return None
    
    gray = image.convert('L')
    
    if range_type == 'shadows':
        # Dark pixels: full effect on luminance < 64, smooth falloff to 127
        table = [min(255, max(0, int(255 * (1 - i / 127)))) if i < 128 else 0 for i in range(256)]
    elif range_type == 'midtones':
        # Medium pixels: smooth rise 64→127, smooth falloff 127→191
        table = []
        for i in range(256):
            if i < 64:
                table.append(0)
            elif i < 127:
                table.append(int(255 * (i - 64) / 63))
            elif i < 192:
                table.append(int(255 * (192 - i) / 65))
            else:
                table.append(0)
    elif range_type == 'highlights':
        # Bright pixels: smooth rise from 127, full effect from 192
        table = [0 if i < 128 else min(255, max(0, int(255 * (i - 128) / 127))) for i in range(256)]
    else:
        return None  # Unknown range, apply to all
    
    return gray.point(table)


# ── Schéma v2 des .edt (contrat partagé backend Python / front-end JS) ──────
# {
#   "v": 2,
#   "controls": [
#     {"id":"c_1","type":"brightness","zones":{"all":1.2,"shadows":1.5,"midtones":1.1,"highlights":1.3}},
#     {"id":"c_2","type":"blur","value":8},
#     {"id":"m_1","type":"mask","value":12,"file":"edit/<base>_mask_m_1.png"}
#   ],
#   "targetFps":30,"playbackRate":1.0,"interpolate":false,
#   "crop":{"x":0,"y":0,"w":0.75,"h":1.0}
# }
# Types ZONAUX (ajustements tonaux) : portent un dict `zones` ; clé absente =
#   neutre (1 pour brightness/contrast/saturation, 0 pour hue).
# Types NON ZONAUX (effets spatiaux + masks) : UNE valeur globale `value` ; un
#   éventuel `range` v1 est supprimé à la migration (le rendu reste global —
#   bug latent v1 : le front proposait des plages jamais appliquées).
_TONAL_TYPES = ('brightness', 'contrast', 'saturation', 'hue')
_SPATIAL_TYPES = ('blur', 'pixelate', 'vignette', 'sharpen')
# Ordre d'application des zones (fixe, documenté pour parité avec le JS) :
# all → shadows → midtones → highlights.
_ZONE_KEYS = ('all', 'shadows', 'midtones', 'highlights')
# Valeur neutre par type tonal.
_TONAL_NEUTRAL = {'brightness': 1.0, 'contrast': 1.0, 'saturation': 1.0, 'hue': 0.0}


def _is_neutral_zone(ctype, value):
    """
    True si `value` est EXACTEMENT la valeur neutre du type tonal `ctype`.
    Comparaison exacte (pas d'epsilon) pour garantir que toute valeur non
    exactement neutre déclenche une passe, comme dans l'ancien code mono-plage.
    Une valeur illisible (None, texte) est traitée comme neutre (passe ignorée
    au lieu d'un crash).
    """
    neutral = _TONAL_NEUTRAL.get(ctype)
    if neutral is None:
        return False
    try:
        return float(value) == neutral
    except (TypeError, ValueError):
        return True


def _migrate_tonal_control(control):
    """Normalise un contrôle TONAL vers le schéma v2 (dict `zones`)."""
    migrated = {k: v for k, v in control.items() if k not in ('value', 'range', 'zones')}
    zones = control.get('zones')
    if isinstance(zones, dict) and len(zones) > 0:
        # Déjà v2 (ou déjà migré) : `zones` fait foi, relicats value/range v1 ignorés.
        migrated['zones'] = dict(zones)
        return migrated
    if 'value' in control or 'range' in control:
        # v1 {value, range} → zones[range || 'all'] = value ; les autres zones
        # restent ABSENTES (= neutres). range inconnu → 'all' (comportement
        # historique : plage inconnue appliquée partout).
        if control.get('value') is None:
            migrated['zones'] = {}
        else:
            zone_key = control.get('range') or 'all'
            if zone_key not in _ZONE_KEYS:
                zone_key = 'all'
            migrated['zones'] = {zone_key: control['value']}
        return migrated
    migrated['zones'] = {}  # Contrôle sans donnée : aucune zone → ignoré au rendu
    return migrated


def _migrate_spatial_control(control):
    """
    Normalise un contrôle NON TONAL (blur/pixelate/vignette/sharpen/mask) :
    `value` globale conservée, `range` supprimé, `zones` sans signification
    (supprimée ; défensivement, zones['all'] est récupérée comme value si le
    front n'a fourni que ça).
    """
    migrated = {k: v for k, v in control.items() if k not in ('value', 'range', 'zones')}
    if 'value' in control:
        migrated['value'] = control['value']
    else:
        zones = control.get('zones')
        if isinstance(zones, dict) and zones.get('all') is not None:
            migrated['value'] = zones.get('all')
    return migrated


def _migrate_control(control):
    """Normalise un contrôle unique vers le schéma v2 selon son type."""
    if not isinstance(control, dict):
        return control
    if control.get('type') in _TONAL_TYPES:
        return _migrate_tonal_control(control)
    return _migrate_spatial_control(control)


def _migrate_edit_data(edit_data):
    """
    Normalise les données d'édition vers le schéma v2, À LA LECTURE, de façon
    IDEMPOTENTE et SANS DESTRUCTION (un v1 relu puis re-sauvegardé devient v2 ;
    le fichier sur disque n'est jamais réécrit par la migration).

    Gère :
    - le format tableau v1 {id, type, value, range} : sur un type TONAL,
      {value, range} → zones[range || 'all'] = value (autres zones neutres =
      absentes), suppression de value/range ; sur un type NON TONAL, value est
      conservée et range supprimé (rendu global inchangé) ;
    - le format plat legacy {'brightness': 1.2, 'brightnessRange': 'shadows'} :
      converti en contrôles puis migré pareil ;
    - les masks (type 'mask') : inchangés (value = feather, file conservé) ;
    - le crop et les clés vidéo (playbackRate/targetFps/interpolate) : inchangés.

    Un .edt sans "v" est considéré v1. Retourne toujours une COPIE normalisée
    estampillée "v": 2 (le dict d'entrée n'est jamais muté).
    """
    if not isinstance(edit_data, dict):
        return edit_data

    result = dict(edit_data)
    result['v'] = 2

    controls = edit_data.get('controls')
    if isinstance(controls, list):
        result['controls'] = [_migrate_control(c) for c in controls]
        return result

    # ── Format plat legacy : {'brightness': 1.2, 'brightnessRange': 'shadows', ...} ──
    # On convertit les clés tonales en contrôles puis on migre chaque contrôle.
    # Les clés vidéo et le crop sont préservés ; les clés tonales converties
    # (brightness, brightnessRange, ...) sont retirées du résultat.
    controls = []
    cid = 0
    for ctype in _TONAL_TYPES:
        if ctype in edit_data:
            cid += 1
            controls.append(_migrate_control({
                'id': f'ctrl_{cid}',
                'type': ctype,
                'value': edit_data[ctype],
                'range': edit_data.get(f'{ctype}Range', 'all')
            }))

    if controls:
        result['controls'] = controls
        for ctype in _TONAL_TYPES:
            result.pop(ctype, None)
            result.pop(f'{ctype}Range', None)
        return result

    return result  # Aucune clé connue : copie estampillée v2, inchangée sinon


def apply_edits_to_image(image, edit_data, mask_images=None):
    """
    Applies adjustments (brightness, contrast, saturation, hue, blur, pixelate,
    vignette, sharpen) to a PIL Image. Supports old flat format, v1 controls
    array (value + range) and the v2 multi-zone schema.

    Contrôles TONAUX (schéma v2, dict `zones`) : chaque zone NON NEUTRE (all /
    shadows / midtones / highlights) est appliquée séquentiellement — ordre
    fixe all → shadows → midtones → highlights — restreinte à sa bande de
    luminance ('all' = partout) et compositée sur le résultat courant, avec les
    mêmes LUT/profils que _get_luminance_mask. Les zones neutres (clé absente
    ou valeur neutre : 1 pour brightness/contrast/saturation, 0 pour hue) ne
    déclenchent AUCUNE passe. UNE seule zone non neutre ⇒ rendu identique à
    l'ancien comportement mono-plage (value + range).
    Contrôles NON TONAUX (blur/pixelate/vignette/sharpen/mask) : valeur
    globale `value` unique (un éventuel `range` v1 est ignoré, comme avant).

    ``mask_images`` (optionnel) : dict { file: PIL Image 'L' } des masks
    référencés par les contrôles de type 'mask'. Pour rétro-compatibilité, un
    ancien paramètre ``mask_image`` (image 'L' unique) est aussi accepté et
    converti en dict { file: image }.

    Les masks sont des éléments ORDONNÉS de la pipeline : un contrôle de type
    'mask' change la zone active pour les contrôles suivants. Le traitement se
    fait par SEGMENTS : le résultat d'un segment est composité avec l'entrée du
    segment par le mask du segment (featheré). Un mask suivant REMPLACE la zone
    active pour les segments suivants.
    """
    if not isinstance(edit_data, dict):
        return image

    # Migrate old format to new controls array if needed
    edit_data = _migrate_edit_data(edit_data)

    controls = edit_data.get('controls', [])
    if not isinstance(controls, list):
        controls = []
    crop = edit_data.get('crop')

    if not controls and not crop:
        return image

    # Rétro-compat : ancien paramètre mask_image (image 'L' unique) → dict
    if mask_images is not None and not isinstance(mask_images, dict):
        mask_images = {'__legacy__': mask_images}

    # Segmente les contrôles aux entrées type=='mask'
    segments = []
    cur = {'mask_ctrl': None, 'controls': []}
    for control in controls:
        if control.get('type') == 'mask':
            if cur['controls'] or cur['mask_ctrl']:
                segments.append(cur)
            cur = {'mask_ctrl': control, 'controls': []}
        else:
            cur['controls'].append(control)
    if cur['controls'] or cur['mask_ctrl']:
        segments.append(cur)

    result = image.copy()

    for seg in segments:
        seg_controls = seg['controls']
        mask_ctrl = seg['mask_ctrl']
        if not seg_controls and not mask_ctrl:
            continue

        # Entrée du segment (avant application des contrôles du segment)
        base = result.copy()

        for control in seg_controls:
            ctype = control.get('type')

            if ctype in _TONAL_TYPES:
                # ── Contrôle tonal multi-plages (schéma v2) ──
                # Chaque zone NON NEUTRE est appliquée séquentiellement, restreinte
                # à sa bande de luminance ('all' = partout), et compositée sur le
                # résultat courant (mêmes LUT/profils que _get_luminance_mask).
                # Les zones neutres (clé absente ou valeur neutre) ne déclenchent
                # AUCUNE passe — une seule zone non neutre ⇒ rendu identique à
                # l'ancien comportement mono-plage (value + range).
                zones = control.get('zones') or {}
                for zone_key in _ZONE_KEYS:  # ordre fixe : all → shadows → midtones → highlights
                    if zone_key not in zones:
                        continue  # clé absente = neutre
                    zone_value = zones[zone_key]
                    if _is_neutral_zone(ctype, zone_value):
                        continue  # zone neutre : aucune passe
                    result = _apply_tonal_zone(result, ctype, zone_value, zone_key)

            elif ctype == 'blur':
                try:
                    radius = max(0.0, float(control.get('value')))
                except (TypeError, ValueError):
                    continue  # valeur illisible → contrôle ignoré
                if radius > 0:
                    result = result.filter(ImageFilter.GaussianBlur(radius))

            elif ctype == 'pixelate':
                try:
                    size = max(2, int(control.get('value')))
                except (TypeError, ValueError):
                    continue  # valeur illisible → contrôle ignoré
                w, h = result.size
                result = result.resize((max(1, w // size), max(1, h // size)), Image.Resampling.NEAREST)
                result = result.resize((w, h), Image.Resampling.NEAREST)

            elif ctype == 'vignette':
                try:
                    result = _apply_vignette(result, float(control.get('value')))
                except (TypeError, ValueError):
                    continue  # valeur illisible → contrôle ignoré

            elif ctype == 'sharpen':
                try:
                    amount = float(control.get('value'))
                except (TypeError, ValueError):
                    continue  # valeur illisible → contrôle ignoré
                if amount > 0:
                    result = result.filter(ImageFilter.UnsharpMask(radius=2, percent=round(min(300, amount * 100)), threshold=2))

        # ── Composite avec le mask du segment (featheré) ──
        if mask_ctrl and mask_images:
            try:
                file_ref = mask_ctrl.get('file')
                mask_image = mask_images.get(file_ref) if file_ref else None
                if mask_image is not None:
                    feather = float(mask_ctrl.get('value', 0) or 0)
                    if feather > 0:
                        mask_image = mask_image.filter(ImageFilter.GaussianBlur(feather))
                    if mask_image.size != result.size:
                        mask_image = mask_image.resize(result.size, Image.Resampling.BILINEAR)
                    result = Image.composite(result, base, mask_image)
            except Exception as e:
                print(f"🟡 [Holaf-Logic] Failed to apply edit mask: {e}")

    # Rétro-compat : ancien mask_image unique (sans contrôle 'mask') → appliqué
    # globalement sur le résultat final (comme l'ancien comportement).
    if mask_images is not None and '__legacy__' in mask_images:
        try:
            legacy_mask = mask_images['__legacy__']
            feather = float(((edit_data.get('mask') or {}).get('feather', 0) or 0))
            if feather > 0:
                legacy_mask = legacy_mask.filter(ImageFilter.GaussianBlur(feather))
            if legacy_mask.size != result.size:
                legacy_mask = legacy_mask.resize(result.size, Image.Resampling.BILINEAR)
            result = Image.composite(result, image, legacy_mask)
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Failed to apply legacy edit mask: {e}")

    # ── Crop : recadrage appliqué EN DERNIER (décision de cadrage final) ──
    # Le crop est normalisé 0-1 relatif à l'ORIGINAL. On le convertit en
    # coordonnées pixels et on recadre le RÉSULTAT final (après contrôles et
    # composite mask). Le mask vit sur l'image COMPLÈTE : ajuster le crop ne
    # l'invalide plus.
    if crop:
        try:
            iw, ih = image.size
            x = max(0, min(1, float(crop['x']))) * iw
            y = max(0, min(1, float(crop['y']))) * ih
            w = min(iw - x, max(1, float(crop['w']) * iw))
            h = min(ih - y, max(1, float(crop['h']) * ih))
            result = result.crop((int(x), int(y), int(x + w), int(y + h)))
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Crop failed: {e}")

    return result


def _apply_tonal_zone(image, ctype, value, range_type):
    """
    Applique UNE passe tonale (brightness/contrast/saturation/hue) soit à toute
    l'image (range_type 'all'), soit restreinte à sa bande de luminance via
    _get_luminance_mask puis compositée sur l'image d'entrée.

    Reproduit à l'identique les passes de l'ancien code mono-plage (value +
    range) : mêmes appels ImageEnhance / mêmes LUT, mask calculé sur l'image
    courante. Retourne toujours une NOUVELLE image (jamais l'objet `image`
    modifié) ; en cas de valeur illisible ou d'échec, l'image d'entrée est
    retournée telle quelle (passe sans effet).
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return image

    if ctype == 'brightness':
        if range_type == 'all':
            return ImageEnhance.Brightness(image).enhance(v)
        mask = _get_luminance_mask(image, range_type)
        if mask:
            return Image.composite(ImageEnhance.Brightness(image.copy()).enhance(v), image, mask)
        return image

    if ctype == 'contrast':
        if range_type == 'all':
            return ImageEnhance.Contrast(image).enhance(v)
        mask = _get_luminance_mask(image, range_type)
        if mask:
            return Image.composite(ImageEnhance.Contrast(image.copy()).enhance(v), image, mask)
        return image

    if ctype == 'saturation':
        if range_type == 'all':
            return ImageEnhance.Color(image).enhance(v)
        mask = _get_luminance_mask(image, range_type)
        if mask:
            return Image.composite(ImageEnhance.Color(image.copy()).enhance(v), image, mask)
        return image

    if ctype == 'hue':
        try:
            hue_deg = v

            def _apply_hue(img):
                img_hsv = img.convert('HSV')
                h, s, v_ = img_hsv.split()
                shift = int((hue_deg % 360) * (255 / 360))
                h = h.point(lambda i: (i + shift) % 255)
                return Image.merge('HSV', (h, s, v_)).convert('RGB')

            if range_type == 'all':
                return _apply_hue(image)
            mask = _get_luminance_mask(image, range_type)
            if mask:
                return Image.composite(_apply_hue(image.copy()), image, mask)
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Failed to apply Hue adjustment: {e}")
        return image

    return image


def _apply_vignette(img, intensity):
    """Assombrit les bords de l'image radialement (intensité 0-1)."""
    if intensity <= 0:
        return img
    alpha = img.getchannel('A') if img.mode in ('RGBA', 'LA') else None
    arr = np.asarray(img.convert('RGB'), dtype=np.float32)
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    # Distance normalisée (0 au centre → ≥1 aux bords), mise à l'échelle
    d = np.sqrt(((xx - cx) / max(cx, 1)) ** 2 + ((yy - cy) / max(cy, 1)) ** 2)
    # Dégradé doux qui ne démarre qu'après ~55% du rayon
    falloff = np.clip((d - 0.55) / 0.9, 0, 1)
    factor = np.clip(intensity * 0.7 * falloff, 0, 1)[..., None]
    out = arr * (1.0 - factor)
    out_img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    if alpha is not None:
        out_img.putalpha(alpha)
    return out_img


def _load_edit_mask(edit_data, original_path_abs):
    """Charge les PNG de mask référencés par les contrôles de type 'mask' du .edt.

    Retourne un dict { file: PIL Image 'L' } pour tous les contrôles de type
    'mask' ayant un champ ``file`` (chemin relatif au dossier de l'image,
    ex: ``edit/<nom>_mask_<id>.png``). Retourne {} si aucun.
    """
    masks = {}
    try:
        controls = (edit_data or {}).get('controls') or []
        for control in controls:
            if control.get('type') != 'mask':
                continue
            file_ref = control.get('file')
            if not file_ref:
                continue
            mask_path = os.path.normpath(os.path.join(os.path.dirname(original_path_abs), str(file_ref)))
            if not os.path.isfile(mask_path):
                continue
            masks[file_ref] = Image.open(mask_path).convert('L')
    except Exception as e:
        print(f"🟡 [Holaf-Logic] Failed to load edit masks: {e}")
    return masks


def build_ffmpeg_filter_string(edit_data):
    """
    Translates edit_data into an FFmpeg filter string (-vf).
    Supports old flat format, v1 controls array and v2 zones schema.

    ── POLITIQUE VIDÉO (schéma v2) ──
    FFmpeg ne peut pas appliquer de masque de luminance par pixel. Pour un
    contrôle TONAL (brightness/contrast/saturation/hue), la valeur plate
    utilisée est zones['all'] SI ELLE EST NON NEUTRE ; sinon le contrôle est
    IGNORÉ (pas d'ajustement partiel par bande en vidéo — statu quo décidé).
    Pour un contrôle NON TONAL (blur/pixelate/vignette/sharpen), la valeur
    globale `value` est utilisée telle quelle (les plages v1 y étaient déjà
    ignorées). Les masks (type 'mask') sont ignorés en vidéo : FFmpeg ne peut
    pas appliquer de masks bitmap par pixel dans un filtre simple -vf.
    """
    if not edit_data:
        return ""
    
    # Normalize to new format and extract flat values
    edit_data = _migrate_edit_data(edit_data)
    
    # Build a flat lookup from controls.
    # Tonal controls: only zones['all'] NON NEUTRE feeds the flat value
    # (zones.all absent/neutre → contrôle ignoré en vidéo). Un contrôle
    # restreint à une bande ne contribue PAS et n'écrase pas la valeur d'un
    # contrôle précédent du même type. Non-tonal controls: value globale.
    flat = {}
    for control in edit_data.get('controls', []):
        ctype = control.get('type')
        if not ctype:
            continue
        if ctype in _TONAL_TYPES:
            zones = control.get('zones') or {}
            all_value = zones.get('all')
            if all_value is not None and not _is_neutral_zone(ctype, all_value):
                flat[ctype] = all_value
        elif ctype in _SPATIAL_TYPES or ctype == 'mask':
            value = control.get('value')
            if value is not None:
                flat[ctype] = value
    # Also copy top-level video keys
    for key in ['playbackRate', 'targetFps', 'interpolate']:
        if key in edit_data:
            flat[key] = edit_data[key]

    filters = []

    # Speed control (setpts)
    if 'playbackRate' in flat:
        try:
            rate = float(flat['playbackRate'])
            if rate > 0 and abs(rate - 1.0) > 0.01:
                filters.append(f"setpts=PTS/{rate}")
        except ValueError:
            pass

    # eq filter handles brightness, contrast, saturation
    eq_parts = []
    if 'contrast' in flat:
        eq_parts.append(f"contrast={flat['contrast']}")
    if 'saturation' in flat:
        eq_parts.append(f"saturation={flat['saturation']}")
    if 'brightness' in flat:
        try:
            b_val = float(flat['brightness'])
            if abs(b_val - 1.0) > 0.001:
                ffmpeg_b = (b_val - 1.0) / 2.0
                eq_parts.append(f"brightness={ffmpeg_b:.3f}")
        except ValueError:
            pass

    if eq_parts:
        filters.append(f"eq={':'.join(eq_parts)}")

    # hue filter
    if 'hue' in flat:
        try:
            h_val = float(flat['hue'])
            if abs(h_val) > 0.01:
                filters.append(f"hue=h={h_val}")
        except ValueError:
            pass

    # blur → gblur
    if 'blur' in flat:
        try:
            r = float(flat['blur'])
            if r > 0:
                filters.append(f"gblur=sigma={max(0.5, r)}")
        except ValueError:
            pass

    # sharpen → unsharp
    if 'sharpen' in flat:
        try:
            a = float(flat['sharpen'])
            if a > 0:
                filters.append(f"unsharp=5:5:{min(1.5, a * 0.5)}")
        except ValueError:
            pass

    # vignette → ffmpeg vignette (angle en radians)
    if 'vignette' in flat:
        try:
            v = float(flat['vignette'])
            if v > 0:
                filters.append(f"vignette=angle={0.2 + v * 0.6}")
        except ValueError:
            pass

    # Crop : recadrage appliqué EN DERNIER (décision de cadrage final)
    crop = edit_data.get('crop')
    if crop:
        try:
            x = max(0, min(1, float(crop['x'])))
            y = max(0, min(1, float(crop['y'])))
            w = max(0.0001, min(1, float(crop['w'])))
            h = max(0.0001, min(1, float(crop['h'])))
            filters.append(f"crop=w=iw*{w:.4f}:h=ih*{h:.4f}:x=iw*{x:.4f}:y=ih*{y:.4f}")
        except Exception as e:
            print(f"🟡 [Holaf-Logic] Crop filter failed: {e}")

    return ",".join(filters)

def _build_atempo_filter(rate):
    """
    Build FFmpeg atempo filter string for the given playback rate.
    atempo supports values between 0.5 and 2.0. For values outside this range,
    multiple filters must be chained.
    Returns None if the rate is effectively 1.0 (no change needed).
    """
    if rate <= 0 or abs(rate - 1.0) < 0.01:
        return None
    filters = []
    remaining = rate
    while remaining < 0.5 or remaining > 2.0:
        if remaining < 0.5:
            filters.append("atempo=0.5")
            remaining /= 0.5
        else:
            filters.append("atempo=2.0")
            remaining /= 2.0
    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)


def transcode_video_with_edits(source_path, dest_path, edit_data, format_ext='mp4', export_options=None):
    """
    Transcodes a video file applying the edits "baked in" via FFmpeg.
    Supports .mp4 (x264) and .gif (palettegen).
    
    UPDATED: Supports targetFps logic. Audio speed adjustment via atempo.
    UPDATED: Supports export_options dict for quality/CRF/preset control.
    """
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("FFmpeg not found")
        
    # --- CALCULATE EFFECTIVE SPEED ---
    native_fps = get_video_fps(source_path)
    target_fps = edit_data.get('targetFps', None)
    
    # Clone edit data to manipulate just for filter generation
    filter_edit_data = edit_data.copy()
    
    speed_changed = False
    
    if target_fps:
        try:
            target_fps_val = float(target_fps)
            if native_fps > 0:
                # Calculate required playback rate to achieve target FPS
                # Rate = Target / Native. e.g. 60 / 30 = 2.0x speed.
                calculated_rate = target_fps_val / native_fps
                filter_edit_data['playbackRate'] = calculated_rate
                
                if abs(calculated_rate - 1.0) > 0.01:
                    speed_changed = True
        except ValueError: pass
    else:
        # Fallback to direct multiplier if no target FPS
        if 'playbackRate' in filter_edit_data:
            try:
                if abs(float(filter_edit_data['playbackRate']) - 1.0) > 0.01:
                    speed_changed = True
            except: pass

    filter_str = build_ffmpeg_filter_string(filter_edit_data)
    
    cmd = [ffmpeg, "-y", "-i", source_path]
    
    action_log = "Copy (No edits)"
    
    # --- EXPORT OPTIONS ---
    options = export_options or {}
    crf = options.get('crf', 23)
    preset = options.get('preset', 'fast')
    jpg_quality = options.get('jpg_quality', 95)
    gif_fps = options.get('gif_fps', None)  # Optional GIF FPS override
    
    if format_ext == 'gif':
        # GIF Generation Strategy:
        # 1. Apply visual filters (eq/hue)
        # 2. Split stream: one for palette generation, one for usage
        # 3. Use paletteuse to map colors properly
        
        # Base filter chain: edits + scaling (optional, keeps orig size here)
        base_filter = filter_str if filter_str else "null"
        
        # Complex filter graph for GIF optimization
        # [0:v] edits [x]; [x] split [a][b]; [a] palettegen [p]; [b][p] paletteuse
        complex_filter = f"{base_filter},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
        
        if not filter_str:
            complex_filter = "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
            
        cmd.extend(["-filter_complex", complex_filter])
        
        # Force frame rate if requested
        effective_gif_fps = gif_fps or target_fps
        if effective_gif_fps:
             cmd.extend(["-r", str(int(effective_gif_fps))])
             
        action_log = f"Transcode to GIF (FPS: {effective_gif_fps})"
    else:
        # MP4 / Standard Video
        if filter_str or speed_changed or target_fps:
            if filter_str:
                cmd.extend(["-vf", filter_str])
            
            # If target FPS is set, force output framerate
            if target_fps:
                cmd.extend(["-r", str(int(target_fps))])

            video_codec = export_options.get('codec', 'libx264') if export_options else 'libx264'
            cmd.extend(["-c:v", video_codec, "-preset", preset, "-crf", str(crf)])
            
            # --- FIX: AUDIO HANDLING WITH ATEMPO ---
            # Instead of removing audio on speed change, we adjust audio tempo to match.
            if speed_changed:
                calculated_rate = filter_edit_data.get('playbackRate', 1.0)
                atempo_str = _build_atempo_filter(calculated_rate)
                if atempo_str:
                    cmd.extend(["-af", atempo_str])
                    cmd.extend(["-c:a", "aac", "-b:a", "128k"])
                    action_log = f"Transcode (Filters: {filter_str}, FPS: {target_fps}, Audio tempo: {calculated_rate:.2f}x)"
                else:
                    # Fallback: extreme tempo, remove audio
                    cmd.extend(["-an"])
                    action_log = f"Transcode (Filters: {filter_str}, FPS: {target_fps}, Audio removed - extreme tempo)"
            else:
                cmd.extend(["-c:a", "copy"])
                action_log = f"Transcode (Filters: {filter_str})"
        else:
            # No filters/edits, but still respect user's quality settings (CRF, codec, preset)
            video_codec = options.get('codec', 'libx264')
            cmd.extend(["-c:v", video_codec, "-preset", preset, "-crf", str(crf)])
            cmd.extend(["-c:a", "copy"])
            action_log = f"Transcode (No filters, codec={video_codec}, CRF={crf}, preset={preset})"

    cmd.append(dest_path)
    
    print(f"🔵 [Holaf-VideoExport] {action_log} -> {os.path.basename(dest_path)}")
    
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = process.communicate()
    
    if process.returncode != 0:
        raise RuntimeError(f"FFmpeg transcode failed: {stderr.decode('utf-8')}")
        
    return True

# --- Font Helper ---
# PIL's default font is tiny (8px). Try multiple system fonts before falling back.
_FONT_CACHE = {}

def _get_pil_font(size):
    """Return a PIL ImageFont of the given size, trying common system fonts."""
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    
    # Common font paths across platforms
    font_paths = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',      # Linux (Debian/Ubuntu)
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',  # Linux (RHEL/Fedora)
        'DejaVuSans.ttf',                                        # Relative (cwd)
        'arial.ttf',                                             # Windows relative
        '/usr/share/fonts/TTF/DejaVuSans.ttf',                   # Linux (Arch)
    ]
    
    for path in font_paths:
        try:
            font = ImageFont.truetype(path, size)
            _FONT_CACHE[size] = font
            return font
        except (OSError, IOError):
            continue
    
    # Last resort: PIL default (tiny, but at least won't crash)
    font = ImageFont.load_default()
    _FONT_CACHE[size] = font
    return font


def _create_thumbnail_blocking(original_path_abs, thumb_path_abs, image_path_canon_for_db_update=None, edit_data=None):
    conn_update_db = None
    update_exception = None
    file_ext = os.path.splitext(original_path_abs)[1].lower()
    generation_succeeded = False

    # --- Perf instrumentation: decode / resize / save ---
    t_start_total = time.perf_counter()
    t_decode_ms = 0.0
    t_resize_ms = 0.0
    t_save_ms = 0.0
    t_total_ms = 0.0

    try:
        if os.path.exists(thumb_path_abs): os.remove(thumb_path_abs)
        t_decode_start = time.perf_counter()
        
        img = None
        
        if file_ext in VIDEO_FORMATS:
            ffmpeg = get_ffmpeg_path()
            if not ffmpeg:
                raise RuntimeError("ffmpeg not found, cannot generate video thumbnail.")
            
            cmd = [
                ffmpeg, "-y", "-ss", "00:00:00", "-i", original_path_abs,
                "-frames:v", "1", "-f", "image2", "pipe:1"
            ]
            
            # --- PROTECTION TIMEOUT ADDED ---
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                stdout, stderr = process.communicate(timeout=10) # 10s max for thumbnail extraction
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
                raise RuntimeError("ffmpeg thumbnail extraction timed out")
            # --------------------------------
            
            if process.returncode != 0:
                raise RuntimeError(f"ffmpeg extraction failed: {stderr.decode('utf-8')}")
                
            from io import BytesIO
            img = Image.open(BytesIO(stdout))
        elif file_ext in AUDIO_FORMATS:
            # --- AUDIO THUMBNAIL: Generate a placeholder image ---
            try:
                audio_thumb_size = 640
                bg_color = (25, 25, 35)
                accent_color = (70, 140, 255)
                label_color = (160, 160, 170)
                img = Image.new('RGB', (audio_thumb_size, audio_thumb_size), bg_color)
                from PIL import ImageDraw, ImageFont
                draw = ImageDraw.Draw(img)
                
                # Draw decorative circle behind the icon
                cx, cy = audio_thumb_size // 2, audio_thumb_size // 2 - 20
                circle_radius = 160
                draw.ellipse(
                    [cx - circle_radius, cy - circle_radius, cx + circle_radius, cy + circle_radius],
                    fill=(35, 35, 50), outline=accent_color, width=3
                )
                
                # Draw music notes icon (large, legible even after resize to 200x200)
                icon_text = "\u266B\u266A"
                font = _get_pil_font(140)
                
                bbox = draw.textbbox((0, 0), icon_text, font=font)
                icon_w = bbox[2] - bbox[0]
                icon_h = bbox[3] - bbox[1]
                draw.text(
                    ((audio_thumb_size - icon_w) / 2, (audio_thumb_size - icon_h) / 2 - 30),
                    icon_text, fill=accent_color, font=font
                )
                
                # Draw file extension label
                ext_label = file_ext[1:].upper()
                small_font = _get_pil_font(36)
                draw.text(
                    (audio_thumb_size / 2, audio_thumb_size - 50),
                    ext_label, fill=label_color, font=small_font, anchor="mm"
                )
            except Exception as e:
                img = Image.new('RGB', (640, 640), (25, 25, 35))
        else:
            img = Image.open(original_path_abs)

        with img:
            target_dim_w, target_dim_h = holaf_utils.THUMBNAIL_SIZE if isinstance(holaf_utils.THUMBNAIL_SIZE, tuple) else (holaf_utils.THUMBNAIL_SIZE, holaf_utils.THUMBNAIL_SIZE)
            original_width, original_height = img.size
            if original_width == 0 or original_height == 0: raise ValueError("Image dimensions cannot be zero.")

            # JPEG : décodage à résolution réduite dès le décodeur (gros gain sur les
            # grosses photos). Sans effet sur PNG. draft() lève une exception pour
            # les modes incompatibles -> ignorée. Le hint est basé sur les dims
            # ORIGINALES (le crop éventuel ne change pas le coût du décodage).
            if img.format == 'JPEG':
                try:
                    img.draft('RGB', (int(original_width * 0.5), int(original_height * 0.5)))
                except Exception:
                    pass

            # Copie plein format UNIQUEMENT si une édition doit être appliquée ;
            # sinon on resize directement (évite un décodage/copie complet inutile).
            if edit_data:
                img_copy = img.copy()
                img_copy = apply_edits_to_image(img_copy, edit_data, _load_edit_mask(edit_data, original_path_abs))
            else:
                img_copy = img

            # Cible de resize : on préserve le ratio de l'image FINALE (post-édition),
            # PAS celui de l'original. Un crop change le ratio → resize sur le ratio
            # original étirerait la miniature (bug « miniature cropée étirée »).
            final_width, final_height = img_copy.size
            if final_width == 0 or final_height == 0: raise ValueError("Edited image dimensions cannot be zero.")
            ratio = min(target_dim_w / final_width, target_dim_h / final_height)
            new_width, new_height = int(final_width * ratio), int(final_height * ratio)
            if new_width <= 0: new_width = 1
            if new_height <= 0: new_height = 1

            # BILINEAR ~2-3x plus rapide que LANCZOS pour une cible 200x200,
            # qualité visuellement quasi identique à cette taille.
            t_before_resize = time.perf_counter()
            img_copy = img_copy.resize((new_width, new_height), Image.Resampling.BILINEAR)
            t_after_resize = time.perf_counter()
            img_to_save = img_copy.convert("RGB")
            img_to_save.save(thumb_path_abs, "JPEG", quality=85, optimize=False)
            t_after_save = time.perf_counter()
            
        generation_succeeded = True
        t_total_ms = (t_after_save - t_start_total) * 1000.0
        t_decode_ms = (t_before_resize - t_decode_start) * 1000.0
        t_resize_ms = (t_after_resize - t_before_resize) * 1000.0
        t_save_ms = (t_after_save - t_after_resize) * 1000.0

    except Image.DecompressionBombError as e:
        # FIX: Legitimate large images (e.g. 18K×18K AI art) exceed Pillow's pixel
        # limit. Full decompression would require excessive RAM, so we gracefully
        # mark the thumbnail as permanently skipped instead of retrying forever.
        update_exception = e
        print(f"🟡 [Holaf-ImageViewer] Image too large for thumbnail (decompression bomb): {original_path_abs}")
        if image_path_canon_for_db_update:
            conn_fail_db_inner = None
            inner_exception = None
            try:
                conn_fail_db_inner = holaf_database.get_db_connection()
                cursor_inner = conn_fail_db_inner.cursor()
                cursor_inner.execute("UPDATE images SET thumbnail_status = 3, thumbnail_priority_score = 9999 WHERE path_canon = ?", (image_path_canon_for_db_update,))
                conn_fail_db_inner.commit()
            except Exception as e_fail_inner:
                inner_exception = e_fail_inner
            finally:
                if conn_fail_db_inner:
                    holaf_database.close_db_connection(exception=inner_exception)
    except UnidentifiedImageError as e:
        # FIX: Missing DB update — thumbnail stayed at status 1 forever, causing
        # the worker to retry corrupted/unidentified images in an infinite loop.
        update_exception = e
        print(f"🟡 [Holaf-ImageViewer] Unidentified image (cannot generate thumbnail): {original_path_abs}")
        if image_path_canon_for_db_update:
            conn_fail_db_inner = None
            inner_exception = None
            try:
                conn_fail_db_inner = holaf_database.get_db_connection()
                cursor_inner = conn_fail_db_inner.cursor()
                cursor_inner.execute("UPDATE images SET thumbnail_status = 3, thumbnail_priority_score = 9999 WHERE path_canon = ?", (image_path_canon_for_db_update,))
                conn_fail_db_inner.commit()
            except Exception as e_fail_inner:
                inner_exception = e_fail_inner
            finally:
                if conn_fail_db_inner:
                    holaf_database.close_db_connection(exception=inner_exception)
    except Exception as e:
        update_exception = e
        print(f"🔴 [Holaf-ImageViewer] Error in _create_thumbnail_blocking for {original_path_abs}: {e}")
        if image_path_canon_for_db_update:
            conn_fail_db_inner = None
            inner_exception = None  # FIX: Initialize before try block to avoid NameError in finally
            try:
                conn_fail_db_inner = holaf_database.get_db_connection()
                cursor_inner = conn_fail_db_inner.cursor()
                cursor_inner.execute("UPDATE images SET thumbnail_status = 3, thumbnail_priority_score = 9999 WHERE path_canon = ?", (image_path_canon_for_db_update,))
                conn_fail_db_inner.commit()
            except Exception as e_fail_inner:
                inner_exception = e_fail_inner
                print(f"🔴 [Holaf-ImageViewer] CRITICAL: ALSO FAILED to update thumbnail error status in DB (inner): {e_fail_inner}")
            finally:
                if conn_fail_db_inner:
                    holaf_database.close_db_connection(exception=inner_exception)
        if os.path.exists(thumb_path_abs):
            try: os.remove(thumb_path_abs)
            except Exception as e_clean: print(f"🔴 [Holaf-ImageViewer] Could not clean up failed thumbnail {thumb_path_abs}: {e_clean}")
    finally:
        if conn_update_db:
            holaf_database.close_db_connection(exception=update_exception)

    if t_total_ms > 100:
        print(f"⚡ [Holaf Perf] thumb {os.path.basename(original_path_abs)} decode={t_decode_ms:.1f}ms resize={t_resize_ms:.1f}ms save={t_save_ms:.1f}ms total={t_total_ms:.1f}ms")

    if generation_succeeded and image_path_canon_for_db_update:
        return _mark_thumbnail_generated_retry(image_path_canon_for_db_update)
    return False


def _mark_thumbnail_generated_retry(path_canon, attempts=4, backoff=0.4):
    """Mark a thumbnail as generated (status=2) with a short busy timeout and
    retries. The thumbnail FILE is already written and valid; only the DB status
    lags. A persistent DB lock here must NEVER flip the row to status=3
    (permanent failure): that would show a permanent "Err" overlay for a valid
    image. If the lock persists, the row is left pending and will be picked up
    later (the route also serves a fresh thumb file directly via mtime).
    """
    last_err = None
    for attempt in range(attempts):
        conn = None
        try:
            conn = sqlite3.connect(holaf_database.DB_PATH, timeout=3)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout = 3000;")
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE images SET thumbnail_status = 2, thumbnail_last_generated_at = ? WHERE path_canon = ?",
                (time.time(), path_canon)
            )
            conn.commit()
            stats_manager.increment_thumbnail()
            return True
        except sqlite3.OperationalError as e:
            last_err = e
            try:
                if conn:
                    conn.rollback()
            except Exception:
                pass
            if attempt < attempts - 1:
                time.sleep(backoff)
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
    print(f"🟡 [Holaf-ImageViewer] Could not mark thumbnail generated for {path_canon} after {attempts} attempts (DB busy): {last_err}")
    return False


def _strip_png_metadata_and_get_mtime(image_abs_path):
    try:
        # FIX: Temporarily disable decompression bomb limit for metadata stripping.
        old_max_pixels = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = None
        try:
            with Image.open(image_abs_path) as img: img.load()
            new_img = Image.new(img.mode, img.size); new_img.putdata(list(img.getdata()))
            new_img.save(image_abs_path, "PNG")
        finally:
            Image.MAX_IMAGE_PIXELS = old_max_pixels
        return os.path.getmtime(image_abs_path)
    except Exception as e: raise RuntimeError(f"Failed to strip metadata: {e}") from e

def _inject_png_metadata_and_get_mtime(image_abs_path, prompt_text=None, workflow_data=None):
    try:
        with Image.open(image_abs_path) as img: img.load()
        png_info = PngImagePlugin.PngInfo()
        if prompt_text: png_info.add_text("prompt", prompt_text)
        if workflow_data: png_info.add_text("workflow", json.dumps(workflow_data))
        img.save(image_abs_path, "PNG", pnginfo=png_info)
        return os.path.getmtime(image_abs_path)
    except Exception as e: raise RuntimeError(f"Failed to inject metadata: {e}") from e

def generate_proc_video(abs_image_path, edit_data, preview_mode=True):
    """
    Generates a processed preview video (_proc.mp4) in the edit folder.
    Pipeline: Extract -> (Optional RIFE) -> Assemble + Filters.
    
    :param preview_mode: If True, skips Color/Contrast filters (but applies RIFE/FPS).
                         This allows CSS to handle colors in real-time in the browser.
    """
    start_time = time.time()
    if not os.path.exists(abs_image_path):
        raise FileNotFoundError("Source video not found")

    # 1. Paths Setup
    proc_path = get_proc_video_path(abs_image_path)
    
    # Try to clean up existing proc file
    if os.path.exists(proc_path):
        try:
            os.remove(proc_path)
        except OSError as e:
            raise RuntimeError(f"Cannot overwrite existing preview (File locked?): {e}")

    # 2. Parse Options
    use_rife = edit_data.get('interpolate', False)
    target_fps = edit_data.get('targetFps', None)
    
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg: raise RuntimeError("FFmpeg not found")
    
    # 3. Create Temp Work Area
    with tempfile.TemporaryDirectory() as temp_root:
        frames_in_dir = os.path.join(temp_root, "frames_in")
        frames_out_dir = os.path.join(temp_root, "frames_out")
        os.makedirs(frames_in_dir)
        os.makedirs(frames_out_dir)

        # 4. Extract Frames
        # We use png for quality.
        print(f"🔵 [Holaf-Logic] Extracting frames from {os.path.basename(abs_image_path)}...")
        cmd_extract = [
            ffmpeg, "-i", abs_image_path, 
            "-vsync", "0", 
            os.path.join(frames_in_dir, "%08d.png")
        ]
        subprocess.check_call(cmd_extract, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)

        # 5. RIFE Interpolation (Optional)
        assemble_source_dir = frames_in_dir
        native_fps = get_video_fps(abs_image_path)
        
        # Determine the base FPS for assembly
        assemble_fps = native_fps

        if use_rife:
            rife_exe = dependency_manager.ensure_rife_ready()
            if not rife_exe:
                raise RuntimeError("RIFE executable not found or installation failed.")
            
            print(f"🔵 [Holaf-Logic] Running RIFE Interpolation (2x)...")
            cmd_rife = [rife_exe, "-i", frames_in_dir, "-o", frames_out_dir]
            
            try:
                subprocess.check_call(cmd_rife, timeout=300)
                assemble_source_dir = frames_out_dir
                # RIFE strictly doubles the frames
                assemble_fps = native_fps * 2
            except subprocess.CalledProcessError as e:
                raise RuntimeError(f"RIFE execution failed (Code {e.returncode}). Check server logs.")

        # 6. Assemble & Apply Filters
        
        # [CRITICAL FIX] We control speed by telling FFmpeg the INPUT framerate.
        # This preserves all frames but changes duration.
        final_framerate = assemble_fps
        if target_fps:
            final_framerate = target_fps
            
        print(f"🔵 [Holaf-Logic] Assembling video (Output FPS: {final_framerate}, Input Source Frames: {assemble_fps} equivalent)...")
        
        cmd_assemble = [
            ffmpeg, 
            "-framerate", str(final_framerate),
            "-i", os.path.join(assemble_source_dir, "%08d.png")
        ]
        
        # Build Filter Chain
        filters = []
        
        # Only bake colors if NOT in preview mode
        if not preview_mode:
            vf_string = build_ffmpeg_filter_string(edit_data)
            if vf_string:
                filters.append(vf_string)
            
        if filters:
            cmd_assemble.extend(["-vf", ",".join(filters)])
            
        # Encoding Settings
        cmd_assemble.extend([
            "-c:v", "libx264", 
            "-pix_fmt", "yuv420p", 
            "-crf", "23", 
            "-preset", "fast",
            "-an", # No audio for now (sync is hard with RIFE)
            "-y", proc_path
        ])
        
        subprocess.check_call(cmd_assemble, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        
    duration = time.time() - start_time
    print(f"✅ [Holaf-Logic] Generated: {proc_path} in {duration:.2f}s")
    
    return {
        "path": proc_path,
        "duration": round(duration, 2),
        "fps_out": final_framerate
    }