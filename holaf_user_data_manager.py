import os

# --- Résolution des chemins : UNE seule source de vérité (holaf_user_paths) ---
# ⚠️ DIVERGENCE CORRIGÉE : ce module composait « <base_path>/user/default » en
# dur alors que aih/store.py, aih/routes.py et aih/credentials.py passaient par
# folder_paths.get_user_directory(). Dès que ComfyUI tourne avec
# --user-directory (ou COMFYUI_USER), les deux familles de chemins DIVERGEAIENT.
try:  # import relatif (pack importé comme extension ComfyUI)
    from . import holaf_user_paths as _user_paths
except ImportError:  # chargé à plat (sys.path = racine du pack, tests par chemin)
    import holaf_user_paths as _user_paths


class UserDataManager:
    """
    Manages data storage locations within the ComfyUI user directory.
    Target structure: ComfyUI/user/[user]/AI-Helper/[subsystem]/
    """
    
    ROOT_NAME = "AI-Helper"
    
    @staticmethod
    def get_user_base_path():
        """
        Determines the base user directory (<ComfyUI>/user/<profil>/).
        Résolution DÉLÉGUÉE à holaf_user_paths (get_user_directory() d'abord).
        """
        return os.path.join(_user_paths.get_comfy_user_dir(), _user_paths.DEFAULT_USER_PROFILE)

    @staticmethod
    def get_root_path():
        """Returns the path to 'ComfyUI/user/default/AI-Helper/'"""
        root = _user_paths.get_user_root()
        if not os.path.exists(root):
            os.makedirs(root, exist_ok=True)
        return root

    @staticmethod
    def get_subsystem_path(subsystem_name):
        """
        Returns path for a specific tool (e.g., 'profiler').
        Creates the directory if it doesn't exist.
        """
        root = UserDataManager.get_root_path()
        path = os.path.join(root, subsystem_name)
        if not os.path.exists(path):
            os.makedirs(path, exist_ok=True)
        return path

    @staticmethod
    def get_profiler_db_path():
        """Specific helper for the profiler database.

        Résolu par holaf_user_paths (profiler/ de la racine utilisateur, avec
        repli sur l'ancien emplacement tant que rien n'a été migré). Le dossier
        parent est créé : ProfilerDatabase ouvre la base directement.
        """
        path = _user_paths.resolved_db_profiler()
        parent = os.path.dirname(path)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        return path