# === Holaf Utilities - Database Manager ===
import sqlite3
import os
import threading
import shutil # For renaming the database file
import time   # For timestamping the backup
import hashlib # Required for migration logic

# --- Constants ---
DB_NAME = "holaf_utilities.sqlite"

# --- User data location (SINGLE SOURCE OF TRUTH: holaf_user_paths) ---
# Emplacement historique : la RACINE DU PACK (ce qui alourdissait
# custom_nodes/ComfyUI-AI-Helper : 1,8 Go pour cette seule base).
# holaf_user_paths.resolved_db_utils() renvoie le NOUVEAU chemin
# (<ComfyUI>/user/default/AI-Helper/db/…) dès que la migration l'a déplacé, et
# l'ANCIEN chemin tant que rien n'a été migré : comportement inchangé sur une
# installation non migrée, aucune base neuve créée à côté des données.
try:  # import relatif (pack importé comme extension ComfyUI)
    from . import holaf_user_paths as _user_paths
except ImportError:  # chargé à plat (sys.path = racine du pack, tests par chemin)
    import holaf_user_paths as _user_paths

DB_PATH = _user_paths.resolved_db_utils()
DB_DIR = os.path.dirname(DB_PATH)
# --- SINGLE SOURCE OF TRUTH FOR DB SCHEMA ---
# Increment this number whenever you make a change to the table structures below.
# Version 13: Performance Tuning (Composite Indexes + WAL/MMAP Optimizations)
LATEST_SCHEMA_VERSION = 13

# --- Thread-local storage for database connections ---
# Ensures each thread gets its own connection, important for SQLite with multiple threads.
local_data = threading.local()

def _create_connection():
    """
    Creates a brand-new sqlite3 connection to DB_PATH with all PRAGMAs applied.

    This is the single source of truth for connection setup, shared by the
    thread-local connection (get_db_connection) and any dedicated connections
    that need to be opened/closed independently (e.g. the GlobalStatsManager).

    IMPORTANT: The returned connection is NOT stored in thread-local storage.
    The caller is responsible for closing it (conn.close()).
    """
    # Ensure the directory exists before trying to connect, crucial for first run
    if not os.path.exists(DB_DIR):
        os.makedirs(DB_DIR, exist_ok=True)

    # --- CORRECTION: Increased timeout to 30s to handle long transactions (Video Export/Scan) ---
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row

    # --- PERFORMANCE TUNING (CRITICAL FOR LISTING SPEED) ---
    # WAL Mode: Allows simultaneous readers and one writer.
    conn.execute("PRAGMA journal_mode=WAL;")

    # Synchronous Normal: Good balance between safety and speed in WAL mode.
    # Significantly faster writes/commits than FULL.
    conn.execute("PRAGMA synchronous = NORMAL;")

    # Memory Mapping: Maps the DB file into RAM.
    # Drastically reduces I/O system calls for reads. Set to ~30GB limit.
    conn.execute("PRAGMA mmap_size = 30000000000;")

    # Cache Size: Increase page cache to ~64MB (negative value = kilobytes).
    conn.execute("PRAGMA cache_size = -64000;")

    # Temp Store: Store temporary tables/indices in RAM, not disk.
    conn.execute("PRAGMA temp_store = MEMORY;")

    conn.execute("PRAGMA foreign_keys = ON;")

    # --- CORRECTION: Increased busy_timeout to 30000ms (30s) ---
    conn.execute("PRAGMA busy_timeout = 30000;")

    return conn


def get_db_connection():
    """Gets or creates a thread-local database connection."""
    if not hasattr(local_data, 'connection') or local_data.connection is None:
        try:
            local_data.connection = _create_connection()
        except sqlite3.Error as e:
            print(f"🔴 [Holaf-DB] Thread {threading.get_ident()}: Error connecting to database at {DB_PATH}: {e}")
            local_data.connection = None # Ensure it's None if connection failed
            raise # Re-raise the exception so the caller knows connection failed
    return local_data.connection


def open_own_connection():
    """
    Opens a DEDICATED database connection that is fully owned by the caller.

    Unlike get_db_connection(), this connection is NOT stored in thread-local
    storage and is NOT affected by close_db_connection(). It is intended for
    short-lived background reads (such as the GlobalStatsManager initialisation)
    that must never close the shared connection another code path is using.

    The caller MUST close it via conn.close() (or close_own_connection(conn)).
    """
    return _create_connection()


def close_own_connection(conn, exception=None):
    """Closes a connection previously opened by open_own_connection()."""
    if conn is None:
        return
    if exception:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
    try:
        conn.close()
    except sqlite3.Error:
        pass


def close_db_connection(exception=None):
    """Closes the thread-local database connection if it exists."""
    if hasattr(local_data, 'connection') and local_data.connection is not None:
        if exception: # If an exception occurred, rollback before closing
            local_data.connection.rollback()
        local_data.connection.close()
        local_data.connection = None


# --- Schema Creation and Migration ---

def _create_fresh_schema(cursor):
    """Creates all tables for a new, empty database with the latest schema."""
    print(f"  > Creating fresh database schema (Version {LATEST_SCHEMA_VERSION})...")

    # Version Table
    cursor.execute("CREATE TABLE holaf_db_version (version INTEGER PRIMARY KEY)")

    # Model Manager: Models Table
    cursor.execute("""
        CREATE TABLE models (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path_canon TEXT NOT NULL UNIQUE,
            type TEXT, family TEXT, size_bytes INTEGER, sha256 TEXT, description TEXT, tags TEXT,
            metadata_json TEXT, last_scanned_at REAL, created_at REAL, notes TEXT,
            is_user_managed BOOLEAN DEFAULT 0, is_disabled BOOLEAN DEFAULT 0, download_url TEXT,
            cover_image_path TEXT, remote_source TEXT, local_mtime REAL
        )
    """)

    # Image Viewer: Images Table (with all columns up to the latest version)
    # Version 10: Added thumb_hash
    cursor.execute("""
        CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, subfolder TEXT,
            top_level_subfolder TEXT,
            path_canon TEXT NOT NULL UNIQUE, format TEXT, width INTEGER, height INTEGER,
            aspect_ratio_str TEXT, size_bytes INTEGER, mtime REAL, prompt_text TEXT,
            workflow_json TEXT, last_synced_at REAL, thumbnail_status INTEGER DEFAULT 0,
            thumbnail_priority_score INTEGER DEFAULT 1000, thumbnail_last_generated_at REAL,
            is_trashed BOOLEAN DEFAULT 0, original_path_canon TEXT, prompt_source TEXT,
            workflow_source TEXT, has_edit_file BOOLEAN DEFAULT 0,
            thumb_hash TEXT,
            -- NEW in v12: Boolean flags for performant sidecar filtering --
            has_workflow BOOLEAN NOT NULL DEFAULT 0,
            has_prompt BOOLEAN NOT NULL DEFAULT 0,
            has_edits BOOLEAN NOT NULL DEFAULT 0,
            has_tags BOOLEAN NOT NULL DEFAULT 0
        )
    """)
    
    # Image Viewer: Tags Table (NEW in v11)
    cursor.execute("""
        CREATE TABLE tags (
            tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    """)

    # Image Viewer: Image-Tag Link Table (NEW in v11)
    cursor.execute("""
        CREATE TABLE imagetags (
            image_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (image_id, tag_id),
            FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE
        )
    """)

    # Image Viewer: Folder Metadata Cache Table
    cursor.execute("""
        CREATE TABLE folder_metadata (
            path_canon TEXT PRIMARY KEY NOT NULL, -- e.g., 'sub/folder' or 'root'
            image_count INTEGER NOT NULL DEFAULT 0,
            last_calculated_at REAL
        )
    """)

    # --- PERFORMANCE INDEXES (Optimized for v13) ---
    
    # 1. The "Covering Index" for the main Gallery View.
    #    Queries usually filter by `is_trashed` AND `top_level_subfolder` AND sort by `mtime DESC`.
    #    Putting all three in one index allows SQLite to satisfy the query purely from the index tree.
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_gallery_composite 
        ON images(is_trashed, top_level_subfolder, mtime DESC)
    """)
    
    # 2. Global Timeline View Index (No folder filter)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_timeline_composite 
        ON images(is_trashed, mtime DESC)
    """)

    # 3. Standard lookups
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_path_canon ON images(path_canon)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_thumb_hash ON images(thumb_hash)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_format ON images(format)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_workflow_source ON images(workflow_source)")

    # 4. Indices for Tagging System
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_imagetags_image_id ON imagetags(image_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_imagetags_tag_id ON imagetags(tag_id)")

    # 5. Indices for Boolean Flags
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_has_workflow ON images(has_workflow)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_has_prompt ON images(has_prompt)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_has_edits ON images(has_edits)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_has_tags ON images(has_tags)")

    # Set the version in the new table
    cursor.execute("INSERT INTO holaf_db_version (version) VALUES (?)", (LATEST_SCHEMA_VERSION,))
    print("  > Schema creation complete.")


def _ensure_performance_indexes(cursor):
    """
    Idempotently ensures the performance-critical composite indexes exist.

    CREATE INDEX IF NOT EXISTS is cheap and safe even when the index already
    exists. This is a safety net for databases that were migrated long ago (via
    _migrate_database_by_copy) or any DB whose index creation was skipped or
    predates v13 — without these indexes, COUNT/LIST queries fall back to a
    full table scan (~900ms on large DBs with big text columns).
    """
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_gallery_composite 
        ON images(is_trashed, top_level_subfolder, mtime DESC)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_timeline_composite 
        ON images(is_trashed, mtime DESC)
    """)


def _migrate_database_by_copy(current_db_version):
    """
    Performs database migration by renaming the old DB, creating a new one,
    and safely transferring existing data.
    """
    print(f"  > Starting database migration from v{current_db_version} to v{LATEST_SCHEMA_VERSION}...")
    close_db_connection() # Ensure all connections to the old DB are closed

    # 1. Rename old database to create a backup
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    # Sauvegardes : backups/ de la racine utilisateur une fois l'arborescence en
    # place, sinon à côté de la base effectivement utilisée (ancien comportement).
    backup_path = os.path.join(
        _user_paths.resolved_backups_dir(), f"{DB_NAME}.backup_v{current_db_version}_{timestamp}"
    )
    try:
        os.makedirs(os.path.dirname(backup_path), exist_ok=True)
        shutil.move(DB_PATH, backup_path)
        print(f"  > Backed up old database to: {os.path.basename(backup_path)}")
    except Exception as e:
        print(f"🔴 [Holaf-DB] CRITICAL: Could not backup database file. Migration aborted. Error: {e}")
        raise Exception("Database backup failed. Cannot proceed with migration.")

    # 2. Create a new database with the fresh schema
    conn = None
    try:
        # get_db_connection will now create and connect to the new empty DB file at DB_PATH
        conn = get_db_connection()
        cursor = conn.cursor()
        _create_fresh_schema(cursor)
        conn.commit()
        print("  > New database created with the latest schema.")

        # 3. Attach the old database and transfer data
        print("  > Attaching old database to transfer data...")
        cursor.execute(f"ATTACH DATABASE ? AS old_db", (backup_path,))

        def get_columns(c, table_name, db_name="main"):
            c.execute(f"PRAGMA {db_name}.table_info({table_name})")
            return {row['name'] for row in c.fetchall()}

        # Transfer data for 'models' table
        try:
            old_models_cols = get_columns(cursor, 'models', 'old_db')
            new_models_cols = get_columns(cursor, 'models', 'main')
            common_cols = list(old_models_cols.intersection(new_models_cols))
            if common_cols:
                cols_str = ", ".join(f'"{col}"' for col in common_cols)
                cursor.execute(f"INSERT INTO main.models ({cols_str}) SELECT {cols_str} FROM old_db.models")
                print(f"    > Transferred {cursor.rowcount} rows to 'models' table.")
        except sqlite3.OperationalError:
             print("    > 'models' table not found in old database. Skipping.")
        except Exception as e:
            print(f"🟡 [Holaf-DB] Warning: Could not transfer data from 'models' table. Error: {e}")

        # Transfer data for 'images' table
        try:
            old_images_cols = get_columns(cursor, 'images', 'old_db')
            new_images_cols = get_columns(cursor, 'images', 'main')
            common_cols = list(old_images_cols.intersection(new_images_cols))
            
            # Filter out columns that we want to re-populate or that might conflict if logic changed
            # top_level_subfolder is handled manually below
            if 'top_level_subfolder' in common_cols:
                 common_cols.remove('top_level_subfolder') 
            
            # thumb_hash is new, so it won't be in common_cols yet
            if 'thumb_hash' in common_cols:
                 common_cols.remove('thumb_hash')

            if common_cols:
                cols_str = ", ".join(f'"{col}"' for col in common_cols)
                # The new boolean columns in `main.images` will get their default value (0) for all transferred rows.
                cursor.execute(f"INSERT INTO main.images ({cols_str}) SELECT {cols_str} FROM old_db.images")
                print(f"    > Transferred {cursor.rowcount} rows to 'images' table.")
                
                # Populate the top_level_subfolder column for existing images
                print("    > Populating 'top_level_subfolder' column for existing images...")
                cursor.execute("""
                    UPDATE images
                    SET top_level_subfolder = CASE
                        WHEN subfolder = '' OR subfolder IS NULL THEN 'root'
                        WHEN INSTR(subfolder, '/') > 0 THEN SUBSTR(subfolder, 1, INSTR(subfolder, '/') - 1)
                        ELSE subfolder
                    END
                """)
                print(f"      ... Done. {cursor.rowcount} rows updated.")

                # Populate the thumb_hash column for existing images
                print("    > Backfilling 'thumb_hash' column based on path_canon...")
                cursor.execute("SELECT id, path_canon FROM images")
                rows = cursor.fetchall()
                updates = []
                for row in rows:
                    if row['path_canon']:
                        # Calculate SHA1 hash of the canonical path, same logic as worker.py
                        h = hashlib.sha1(row['path_canon'].encode('utf-8')).hexdigest()
                        updates.append((h, row['id']))
                
                if updates:
                    cursor.executemany("UPDATE images SET thumb_hash = ? WHERE id = ?", updates)
                    print(f"      ... Done. {len(updates)} thumb_hashes generated.")

        except sqlite3.OperationalError:
            print("    > 'images' table not found in old database. Skipping.")
        except Exception as e:
            print(f"🟡 [Holaf-DB] Warning: Could not transfer data from 'images' table. Error: {e}")

        # folder_metadata, tags, and imagetags are new, so no data to transfer.

        # 4. Finalize
        conn.commit()
        cursor.execute("DETACH DATABASE old_db")
        print("  > Data transfer complete. Migration successful.")

    except Exception as e:
        print(f"🔴 [Holaf-DB] CRITICAL: An error occurred during migration: {e}")
        close_db_connection()
        try:
            # Preserve the failed new DB and restore the backup for user inspection
            os.rename(DB_PATH, f"{DB_PATH}.failed_migration_{timestamp}")
            print(f"    ! Moved potentially corrupt new DB to: {os.path.basename(DB_PATH)}.failed_migration_{timestamp}")
            shutil.move(backup_path, DB_PATH)
            print(f"    ! Restored original database from backup. The application can restart with the old DB.")
        except Exception as restore_e:
            print(f"    ! FAILED TO RESTORE BACKUP. Manual intervention required. Backup is at: {backup_path}")
        raise # Re-raise the original exception to halt execution
    finally:
        if conn:
            close_db_connection()


def init_database():
    """
    Initializes the database. Creates it if it doesn't exist, or migrates it
    to the latest version if it's outdated.
    """
    print("🔵 [Holaf-DB] Checking database status...")

    if not os.path.exists(DB_PATH):
        print("  > Database file not found. Creating a new one.")
        conn = None
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            _create_fresh_schema(cursor)
            conn.commit()
            print("✅ [Holaf-DB] New database created successfully.")
        except Exception as e:
            print(f"🔴 [Holaf-DB] Failed to create new database: {e}")
        finally:
            if conn:
                close_db_connection()
        return

    # If DB exists, check its version.
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        current_db_version = 0
        try:
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='holaf_db_version'")
            if cursor.fetchone():
                cursor.execute("SELECT version FROM holaf_db_version")
                db_version_row = cursor.fetchone()
                current_db_version = db_version_row[0] if db_version_row else 0
            else:
                print("  > 'holaf_db_version' table not found. Assuming legacy version 0.")
                current_db_version = 0
        except sqlite3.Error as e:
            print(f"  > Could not read DB version, assuming version 0. Error: {e}")
            current_db_version = 0

        if current_db_version < LATEST_SCHEMA_VERSION:
            print(f"  > Database is outdated (v{current_db_version}). Required version is v{LATEST_SCHEMA_VERSION}.")
            close_db_connection() # Close connection before migrating
            _migrate_database_by_copy(current_db_version)
            print("✅ [Holaf-DB] Database migration process complete.")
            # The migration closed its own connection; reopen so we can ensure
            # the performance indexes below.
            conn = get_db_connection()
            cursor = conn.cursor()
        elif current_db_version > LATEST_SCHEMA_VERSION:
            print(f"🟡 [Holaf-DB] Warning: Database version (v{current_db_version}) is newer than the code's schema version (v{LATEST_SCHEMA_VERSION}).")
            print("    This can happen after downgrading the extension. Some features may not work correctly.")
        else:
            print(f"  > Database schema is up to date (version {current_db_version}).")

        # --- PERFORMANCE SAFETY NET ---
        # Idempotently guarantee the composite indexes exist on every startup.
        # CREATE INDEX IF NOT EXISTS is cheap even when already present. This
        # fixes migrated/legacy DBs missing the index, where the COUNT/list
        # queries degenerate into a ~900ms full table scan.
        _ensure_performance_indexes(cursor)
        conn.commit()

    except Exception as e:
        print(f"🔴 [Holaf-DB] An error occurred during database initialization: {e}")
        # traceback.print_exc()
    finally:
        if hasattr(local_data, 'connection') and local_data.connection is not None:
             close_db_connection()


if __name__ == '__main__':
    print(f"Attempting to initialize database at: {DB_PATH}")
    # To test creation/migration, manually remove or place an old DB file here.
    init_database()
    conn_test = None
    try:
        conn_test = get_db_connection()
        if conn_test:
            print("\n--- Verification ---")
            print("Database connection successful.")
            cursor_test = conn_test.cursor()

            cursor_test.execute("SELECT version FROM holaf_db_version")
            version = cursor_test.fetchone()[0]
            print(f"DB Version in table: {version}")
            assert version == LATEST_SCHEMA_VERSION, "Version in DB does not match latest schema version!"

            cursor_test.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = [table[0] for table in cursor_test.fetchall()]
            print("Tables in database:", tables)
            expected_tables = ['holaf_db_version', 'models', 'images', 'folder_metadata', 'tags', 'imagetags']
            for table in expected_tables:
                 assert table in tables, f"FAILURE: '{table}' table was not created."
            print("✅ All required tables are present.")
            
            # Verify new columns/indexes
            cursor_test.execute("PRAGMA table_info(images)")
            cols = [col['name'] for col in cursor_test.fetchall()]
            print("Columns in images:", cols)
            assert 'thumb_hash' in cols, "CRITICAL: thumb_hash column missing!"

            cursor_test.execute("PRAGMA index_list(images)")
            indexes = [idx['name'] for idx in cursor_test.fetchall()]
            print("Indexes on 'images' table:", indexes)
            assert 'idx_gallery_composite' in indexes, "CRITICAL: Composite index was not created!"
            assert 'idx_images_thumb_hash' in indexes, "CRITICAL: thumb_hash index was not created!"
            print("✅ All required indexes are present.")


        else:
            print("Failed to get database connection.")
    except Exception as e:
        print(f"Error during __main__ test: {e}")
    finally:
        if conn_test:
            close_db_connection()
            print("Test connection closed.")