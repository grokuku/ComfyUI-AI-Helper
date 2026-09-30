# === Holaf Utilities - Configuration Manager ===
import configparser
import os
import platform
import asyncio
import re
import traceback
import json

CONFIG_LOCK = asyncio.Lock()
IS_WINDOWS = platform.system() == "Windows" # Needed for default shell

# Strict allow-list for bulk settings updates (used by
# POST /holaf/utilities/save-all-settings). Only UI preferences may be written
# through this route. [Security] and [Terminal] are explicitly excluded so an
# attacker cannot inject a sensitive credential (SFTP password / API token) or a
# Terminal.shell_command (RCE). This is a defense-in-depth guard, NOT application
# authentication: the pack itself ships no password mechanism.
ALLOWED_BULK_SECTIONS = {
    'TerminalUI': {
        'theme', 'font_size', 'panel_x', 'panel_y', 'panel_width',
        'panel_height', 'panel_is_fullscreen',
    },
    'ModelManagerUI': {
        'theme', 'panel_x', 'panel_y', 'panel_width', 'panel_height',
        'panel_is_fullscreen', 'filter_type', 'filter_search_text',
        'sort_column', 'sort_order', 'zoom_level',
    },
    'ImageViewerUI': {
        'theme', 'panel_x', 'panel_y', 'panel_width', 'panel_height',
        'panel_is_fullscreen', 'thumbnail_fit', 'thumbnail_size',
        'export_format', 'export_include_meta', 'export_meta_method',
        'search_text', 'startdate', 'enddate', 'startDate', 'endDate',
        'search_scope_name', 'search_scope_prompt', 'search_scope_workflow',
        'workflow_filter_internal', 'workflow_filter_external',
        'folder_filters', 'format_filters', 'locked_folders',
    },
    'NodesManagerUI': {
        'theme', 'panel_x', 'panel_y', 'panel_width', 'panel_height',
        'panel_is_fullscreen', 'zoom_level', 'filter_text',
    },
}

BLOCKED_BULK_SECTIONS = {'Security', 'Terminal'}

# Defense in depth: even if a key made it into the allow-list by mistake, never
# accept keys that look like commands, paths or credentials.
SENSITIVE_KEY_PATTERN = re.compile(
    r'(shell|command|password|passwd|secret|token|executable|exec|bin|path)',
    re.IGNORECASE,
)

def get_config_path():
    return os.path.join(os.path.dirname(__file__), 'config.ini')

def get_config_parser():
    config = configparser.ConfigParser()
    config.read(get_config_path())
    return config

def _parse_panel_settings(config_parser_obj, section_name, defaults):
    settings = {
        'theme': config_parser_obj.get(section_name, 'theme', fallback=defaults.get('theme', 'Dark')),
        'panel_x': config_parser_obj.get(section_name, 'panel_x', fallback=defaults.get('panel_x', None)),
        'panel_y': config_parser_obj.get(section_name, 'panel_y', fallback=defaults.get('panel_y', None)),
        'panel_width': config_parser_obj.getint(section_name, 'panel_width', fallback=defaults.get('panel_width', 600)),
        'panel_height': config_parser_obj.getint(section_name, 'panel_height', fallback=defaults.get('panel_height', 400)),
        'panel_is_fullscreen': config_parser_obj.getboolean(section_name, 'panel_is_fullscreen', fallback=defaults.get('panel_is_fullscreen', False)),
    }
    if settings['panel_x'] is not None:
        try: settings['panel_x'] = int(settings['panel_x'])
        except (ValueError, TypeError): settings['panel_x'] = None
    else:
        settings['panel_x'] = None
    if settings['panel_y'] is not None:
        try: settings['panel_y'] = int(settings['panel_y'])
        except (ValueError, TypeError): settings['panel_y'] = None
    else:
        settings['panel_y'] = None
    return settings

def load_all_configs():
    config_parser_obj = get_config_parser()
    
    default_shell = 'cmd.exe' if IS_WINDOWS else ('bash' if os.path.exists('/bin/bash') else 'sh')
    shell_cmd = config_parser_obj.get('Terminal', 'shell_command', fallback=default_shell)

    ui_terminal_defaults = {'panel_width': 600, 'panel_height': 400}
    ui_settings_terminal = _parse_panel_settings(config_parser_obj, 'TerminalUI', ui_terminal_defaults)
    ui_settings_terminal.update({
        'font_size': config_parser_obj.getint('TerminalUI', 'font_size', fallback=14),
    })

    ui_model_manager_defaults = {'panel_width': 800, 'panel_height': 550}
    ui_settings_model_manager = _parse_panel_settings(config_parser_obj, 'ModelManagerUI', ui_model_manager_defaults)
    ui_settings_model_manager.update({
        'filter_type': config_parser_obj.get('ModelManagerUI', 'filter_type', fallback='All'),
        'filter_search_text': config_parser_obj.get('ModelManagerUI', 'filter_search_text', fallback=''),
        'sort_column': config_parser_obj.get('ModelManagerUI', 'sort_column', fallback='name'),
        'sort_order': config_parser_obj.get('ModelManagerUI', 'sort_order', fallback='asc'),
        'zoom_level': config_parser_obj.getfloat('ModelManagerUI', 'zoom_level', fallback=1.0),
    })

    ui_image_viewer_defaults = {'panel_width': 1200, 'panel_height': 800}
    ui_settings_image_viewer = _parse_panel_settings(config_parser_obj, 'ImageViewerUI', ui_image_viewer_defaults)
    
    try:
        folder_filters = json.loads(config_parser_obj.get('ImageViewerUI', 'folder_filters', fallback='[]'))
    except json.JSONDecodeError:
        folder_filters = []
    try:
        format_filters = json.loads(config_parser_obj.get('ImageViewerUI', 'format_filters', fallback='[]'))
    except json.JSONDecodeError:
        format_filters = []
    try:
        locked_folders = json.loads(config_parser_obj.get('ImageViewerUI', 'locked_folders', fallback='[]'))
    except json.JSONDecodeError:
        locked_folders = []

    ui_settings_image_viewer.update({
        'folder_filters': folder_filters,
        'format_filters': format_filters,
        'locked_folders': locked_folders,
        'thumbnail_fit': config_parser_obj.get('ImageViewerUI', 'thumbnail_fit', fallback='cover'),
        'thumbnail_size': config_parser_obj.getint('ImageViewerUI', 'thumbnail_size', fallback=150),
        'export_format': config_parser_obj.get('ImageViewerUI', 'export_format', fallback='png'),
        'export_include_meta': config_parser_obj.getboolean('ImageViewerUI', 'export_include_meta', fallback=True),
        'export_meta_method': config_parser_obj.get('ImageViewerUI', 'export_meta_method', fallback='embed'),
        'search_text': config_parser_obj.get('ImageViewerUI', 'search_text', fallback=''),
        'startDate': config_parser_obj.get('ImageViewerUI', 'startdate', fallback=''),
        'endDate': config_parser_obj.get('ImageViewerUI', 'enddate', fallback=''),
        'search_scope_name': config_parser_obj.getboolean('ImageViewerUI', 'search_scope_name', fallback=True),
        'search_scope_prompt': config_parser_obj.getboolean('ImageViewerUI', 'search_scope_prompt', fallback=True),
        'search_scope_workflow': config_parser_obj.getboolean('ImageViewerUI', 'search_scope_workflow', fallback=True),
        'workflow_filter_internal': config_parser_obj.getboolean('ImageViewerUI', 'workflow_filter_internal', fallback=True),
        'workflow_filter_external': config_parser_obj.getboolean('ImageViewerUI', 'workflow_filter_external', fallback=True),
    })
    
    ui_nodes_manager_defaults = {'panel_width': 900, 'panel_height': 600}
    ui_settings_nodes_manager = _parse_panel_settings(config_parser_obj, 'NodesManagerUI', ui_nodes_manager_defaults)
    ui_settings_nodes_manager.update({
         'filter_text': config_parser_obj.get('NodesManagerUI', 'filter_text', fallback=''),
         'zoom_level': config_parser_obj.getfloat('NodesManagerUI', 'zoom_level', fallback=1.0),
    })

    return {
        'shell_command': shell_cmd,
        'ui_terminal': ui_settings_terminal,
        'ui_model_manager': ui_settings_model_manager,
        'ui_image_viewer': ui_settings_image_viewer,
        'ui_nodes_manager': ui_settings_nodes_manager
    }

async def save_setting_to_config(section, key, value):
    async with CONFIG_LOCK:
        config_path = get_config_path()
        config_parser_obj = get_config_parser()
        
        if not config_parser_obj.has_section(section):
            config_parser_obj.add_section(section)
        
        if value is None:
            if config_parser_obj.has_option(section, key):
                config_parser_obj.remove_option(section, key)
        else:
            config_parser_obj.set(section, str(key), str(value))
            
        with open(config_path, 'w') as configfile:
            config_parser_obj.write(configfile)

async def save_bulk_settings_to_config(settings_data):
    """ Saves multiple settings, typically from the save-all-settings route.

    SECURITY: This uses a strict allow-list of sections and keys. Unknown
    sections/keys are ignored (with a log entry) rather than written, and the
    [Security] and [Terminal] sections are always rejected. This prevents an
    attacker from injecting Terminal.shell_command or a sensitive credential
    (SFTP password / API token) through the API.
    """
    if not isinstance(settings_data, dict):
        print("🟡 [Holaf-Config] Bulk settings ignored: payload is not a JSON object.")
        return

    async with CONFIG_LOCK:
        config_path = get_config_path()
        config_parser_obj = get_config_parser()
        wrote_any = False

        for section, settings in settings_data.items():
            if not isinstance(section, str):
                continue

            if section in BLOCKED_BULK_SECTIONS:
                print(f"🔴 [Holaf-Config] Bulk settings rejected: section '{section}' is not writable through this route.")
                continue

            if section not in ALLOWED_BULK_SECTIONS:
                print(f"🔴 [Holaf-Config] Bulk settings rejected: unknown section '{section}' ignored.")
                continue

            if not isinstance(settings, dict):
                print(f"🟡 [Holaf-Config] Bulk settings ignored for section '{section}': expected a JSON object.")
                continue

            allowed_keys = ALLOWED_BULK_SECTIONS[section]

            for key, value in settings.items():
                if not isinstance(key, str):
                    continue

                safe_key = re.sub(r'[^a-zA-Z0-9_]', '', key)
                if not safe_key:
                    continue

                if safe_key not in allowed_keys or SENSITIVE_KEY_PATTERN.search(safe_key):
                    print(f"🔴 [Holaf-Config] Bulk settings rejected: key '{safe_key}' in section '{section}' is not allowed.")
                    continue

                if not config_parser_obj.has_section(section):
                    config_parser_obj.add_section(section)

                if value is None or str(value).strip() == '':
                    if config_parser_obj.has_option(section, safe_key):
                        config_parser_obj.remove_option(section, safe_key)
                else:
                    config_parser_obj.set(section, str(safe_key), str(value))

                wrote_any = True

        if wrote_any:
            with open(config_path, 'w') as configfile:
                config_parser_obj.write(configfile)