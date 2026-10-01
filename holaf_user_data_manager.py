import os
import folder_paths

class UserDataManager:
    """
    Manages data storage locations within the ComfyUI user directory.
    Target structure: ComfyUI/user/[user]/AI-Helper/[subsystem]/
    """
    
    ROOT_NAME = "AI-Helper"
    
    @staticmethod
    def get_user_base_path():
        """
        Determines the base user directory.
        Defaults to 'default' if not explicitly set by ComfyUI args.
        """
        base_path = folder_paths.base_path
        user_dir = "default"
        target_path = os.path.join(base_path, "user", user_dir)
        return target_path

    @staticmethod
    def get_root_path():
        """Returns the path to 'ComfyUI/user/default/AI-Helper/'"""
        base = UserDataManager.get_user_base_path()
        root = os.path.join(base, UserDataManager.ROOT_NAME)
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
        """Specific helper for the profiler database."""
        profiler_dir = UserDataManager.get_subsystem_path("profiler")
        return os.path.join(profiler_dir, "holaf_profiler.db")