import os
import sqlite3
import json
import time
import threading

# Emplacement des données utilisateur : UNE seule source de vérité
# (holaf_user_paths). La base du profiler vit dans profiler/ de la racine
# utilisateur du pack ; le repli sur l'ancien emplacement est assuré par
# resolved_db_profiler().
try:  # import relatif (pack importé comme extension ComfyUI)
    from . import holaf_user_paths as _user_paths
except ImportError:  # chargé à plat (sys.path = racine du pack, tests par chemin)
    import holaf_user_paths as _user_paths


def _profiler_db_path():
    """Chemin de holaf_profiler.db (+ création du dossier parent).

    Passer par holaf_user_paths évite une DEUXIÈME source de vérité (ce module
    calculait son chemin via UserDataManager, qui le délègue désormais au même
    helper). Le dossier parent est créé : la base est ouverte directement.
    """
    path = _user_paths.resolved_db_profiler()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return path


class ProfilerDatabase:
    def __init__(self):
        self.db_path = _profiler_db_path()
        self._local = threading.local()
        self._init_db()

    def _get_connection(self):
        """Gets or creates a thread-local database connection."""
        if not hasattr(self._local, 'connection') or self._local.connection is None:
            conn = sqlite3.connect(self.db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON;")
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA busy_timeout = 30000;")
            self._local.connection = conn
        return self._local.connection

    def _close_connection(self):
        """Closes the thread-local connection if it exists."""
        if hasattr(self._local, 'connection') and self._local.connection is not None:
            self._local.connection.close()
            self._local.connection = None

    def _init_db(self):
        conn = self._get_connection()
        cursor = conn.cursor()

        # 1. Runs Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS profiler_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                name TEXT,
                workflow_hash TEXT,
                global_comment TEXT,
                total_time REAL
            )
        ''')

        # 2. Steps Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS profiler_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                node_id TEXT,
                node_title TEXT,
                node_type TEXT,
                vram_start INTEGER,
                vram_max INTEGER,
                vram_end INTEGER,
                exec_time REAL,
                cpu_max REAL,
                gpu_load_max REAL,
                gpu_load_avg REAL,
                inputs_json TEXT,
                step_comment TEXT,
                FOREIGN KEY(run_id) REFERENCES profiler_runs(id) ON DELETE CASCADE
            )
        ''')

        # 3. Groups Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS profiler_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                color TEXT,
                description TEXT
            )
        ''')

        # 4. Group Members Table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS profiler_group_members (
                group_id INTEGER,
                node_id TEXT,
                FOREIGN KEY(group_id) REFERENCES profiler_groups(id) ON DELETE CASCADE,
                UNIQUE(group_id, node_id)
            )
        ''')

        conn.commit()
        self._close_connection()
        self._migrate_db()

    def _migrate_db(self):
        """Add new columns to profiler_runs if they don't exist yet."""
        conn = self._get_connection()
        cursor = conn.cursor()

        # Get existing columns in profiler_runs
        cursor.execute("PRAGMA table_info(profiler_runs)")
        existing_columns = {row['name'] for row in cursor.fetchall()}

        new_columns = {
            'linked_output_path': 'TEXT',
            'workflow_json': 'TEXT',
            'node_count': 'INTEGER DEFAULT 0',
        }

        for col_name, col_type in new_columns.items():
            if col_name not in existing_columns:
                try:
                    cursor.execute(f"ALTER TABLE profiler_runs ADD COLUMN {col_name} {col_type}")
                except Exception as e:
                    print(f"[Holaf Profiler DB] Migration error adding column {col_name}: {e}")

        conn.commit()
        self._close_connection()

    def create_run(self, name, workflow_hash, comment=""):
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO profiler_runs (name, workflow_hash, global_comment, timestamp) VALUES (?, ?, ?, ?)",
            (name, workflow_hash, comment, time.time())
        )
        run_id = cursor.lastrowid
        conn.commit()
        self._close_connection()
        return run_id

    def add_step(self, run_id, node_id, node_title, node_type, vram_start, vram_max, vram_end, exec_time, cpu_max, gpu_load_max, gpu_load_avg, inputs_json, step_comment=""):
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO profiler_steps (
                run_id, node_id, node_title, node_type, 
                vram_start, vram_max, vram_end, 
                exec_time, cpu_max, gpu_load_max, gpu_load_avg, 
                inputs_json, step_comment
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            run_id, node_id, node_title, node_type,
            vram_start, vram_max, vram_end,
            exec_time, cpu_max, gpu_load_max, gpu_load_avg,
            inputs_json, step_comment
        ))
        conn.commit()
        self._close_connection()

    def get_run_steps(self, run_id):
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM profiler_steps WHERE run_id = ? ORDER BY id ASC", (run_id,))
        rows = cursor.fetchall()
        self._close_connection()
        return [dict(row) for row in rows]

    def finalize_run(self, run_id, total_time, node_count):
        """Set the total time and node count for a finished run."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE profiler_runs SET total_time=?, node_count=? WHERE id=?",
            (total_time, node_count, run_id)
        )
        conn.commit()
        self._close_connection()

    def list_runs(self, limit=50, offset=0):
        """List runs ordered by most recent first (without workflow_json which is too large)."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, timestamp, total_time, node_count, global_comment, linked_output_path
            FROM profiler_runs
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset)
        )
        rows = cursor.fetchall()
        self._close_connection()
        return [dict(row) for row in rows]

    def get_run(self, run_id):
        """Get all columns of a single run (including workflow_json)."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM profiler_runs WHERE id=?", (run_id,))
        row = cursor.fetchone()
        self._close_connection()
        return dict(row) if row else None

    def update_run_comment(self, run_id, comment):
        """Update the global comment for a run."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE profiler_runs SET global_comment=? WHERE id=?",
            (comment, run_id)
        )
        conn.commit()
        self._close_connection()

    def update_run_output(self, run_id, path):
        """Update the linked output path for a run."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE profiler_runs SET linked_output_path=? WHERE id=?",
            (path, run_id)
        )
        conn.commit()
        self._close_connection()

    def save_workflow_json(self, run_id, workflow_json):
        """Store the raw workflow JSON for a run."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE profiler_runs SET workflow_json=? WHERE id=?",
            (workflow_json, run_id)
        )
        conn.commit()
        self._close_connection()

    def get_workflow_json(self, run_id):
        """Retrieve the raw workflow JSON for a run."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT workflow_json FROM profiler_runs WHERE id=?", (run_id,))
        row = cursor.fetchone()
        self._close_connection()
        return row['workflow_json'] if row else None

    def delete_run(self, run_id):
        """Delete a run (and cascade-delete its steps via foreign key)."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM profiler_runs WHERE id=?", (run_id,))
        conn.commit()
        self._close_connection()

    def get_run_summary(self, run_id):
        """Get aggregated stats for a run's steps."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                COUNT(*) as step_count,
                SUM(exec_time) as total_exec_time,
                MAX(vram_max) as max_vram,
                AVG(gpu_load_avg) as avg_gpu,
                MAX(gpu_load_max) as max_gpu
            FROM profiler_steps
            WHERE run_id=?
            """,
            (run_id,)
        )
        row = cursor.fetchone()
        self._close_connection()
        return dict(row) if row else None

    def get_steps_for_comparison(self, run_ids):
        """Get steps for multiple runs, ordered by run then node_id."""
        if not run_ids:
            return []
        conn = self._get_connection()
        cursor = conn.cursor()
        placeholders = ','.join('?' for _ in run_ids)
        cursor.execute(
            f"""
            SELECT run_id, node_id, node_title, node_type, exec_time, vram_max, gpu_load_max, gpu_load_avg
            FROM profiler_steps
            WHERE run_id IN ({placeholders})
            ORDER BY run_id, node_id
            """,
            tuple(run_ids)
        )
        rows = cursor.fetchall()
        self._close_connection()
        return [dict(row) for row in rows]