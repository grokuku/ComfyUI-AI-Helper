# Holaf Utilities for ComfyUI.

## 🚨 ***EXTREMELY IMPORTANT SECURITY WARNING*** 🚨

**This custom extension provides powerful tools, including a web terminal (shell) interface, to the machine running the ComfyUI server. By installing and using this extension, you are opening a direct and potentially dangerous access point to your system.**

**USE THIS EXTENSION AT YOUR OWN RISK. THE AUTHOR(S) ARE NOT RESPONSIBLE FOR ANY DAMAGE, DATA LOSS, OR SECURITY BREACHES THAT MAY RESULT FROM ITS USE.**

---

### Before you proceed, you MUST understand:

1.  **Remote Code Execution:** The Terminal utility is designed to execute shell commands on your server from a web browser. If your ComfyUI is accessible on a network (even a local one), anyone who can access the ComfyUI web page could potentially take control of your server.
2.  **Network Security:** **DO NOT EXPOSE** your ComfyUI instance to the public internet (e.g., using `--listen 0.0.0.0`) with this extension installed, unless you have secured it behind a robust authentication layer (like a reverse proxy with a login/password) and are using **HTTPS**.
3.  **Password session (one prompt per browser session):** The Terminal,
    Nodes Manager, Model Manager and Blobby shell endpoints are protected by a
    password. The FIRST protected tool you use shows the password prompt
    (setup on first run, minimum **8 characters**); every other tool then
    reuses the same session without asking again. The session cookie is a
    BROWSER SESSION cookie (`holaf_session`, no `Max-Age`/`Expires`): it dies
    when the browser is closed. There is deliberately **no login
    rate-limiting** — keep ComfyUI behind an authenticated reverse proxy.
    There is also **no session timeout**: a session never expires server-side,
    so a long (silent) operation such as a HuggingFace download can never log
    you out or close your terminal mid-run.
4.  **Intended Use:** This tool is intended for advanced users who need to perform system maintenance (manage files, update repositories, monitor processes with `nvidia-smi`) on a remote or headless ComfyUI server without needing a separate SSH session.

**If you do not understand these risks, DO NOT INSTALL THIS EXTENSION.**

---

### 🔐 Sensitive routes require the shared password session

A single password (hash stored in `config.ini` under `[Security] /
password_hash`) protects the following endpoints. They always return `401`
without a valid `holaf_session` cookie — there is **no local-only exemption**:

* `GET /holaf/terminal` (WebSocket) — interactive shell (RCE).
* `POST /holaf/utilities/restart` — restarts the ComfyUI server.
* `POST /holaf/models/upload-chunk`, `POST /holaf/models/finalize-upload`,
  `POST /holaf/models/delete`, `POST /holaf/models/deep-scan-local`.
* `POST /holaf/nodes/update`, `/holaf/nodes/delete`, `/holaf/nodes/install`,
  `/holaf/nodes/install-requirements` — `git`/`pip` operations on custom nodes.
* `GET/POST /aih/credentials`, `GET /aih/openai/keys` — read/write local
  credentials.
* `POST /aih/update` — `git fetch` + `git reset --hard` on the pack.
* `POST /api/aih/custom-nodes/install`.
* `POST/GET /aih/blobby/save`, `/aih/blobby/load`, `POST /aih/blobby/exec`.

Auth endpoints (shared by every frontend, see `js/holaf_auth.js`):
`POST /holaf/auth/login`, `POST /holaf/auth/setup` (first-time setup / change),
`POST /holaf/auth/logout`, `GET /holaf/auth/status`.

* **Session duration:** browser session only (cookie without `Max-Age`). The
  signed token has **no server-side expiry**: a session ends ONLY with an
  explicit logout (`POST /holaf/auth/logout`) or when the browser is closed.
  ⚠️ Accepted trade-off: a stolen token stays valid until logout — the only
  other bound is the browser-session cookie. Deploy behind an authenticated
  reverse proxy.
* **Minimum password length:** 8 characters (`AIH_MIN_PASSWORD_LENGTH` can
  raise it; existing hashes are unaffected).
* **One prompt per session:** the first protected tool opens the shared
  `AIH.Dialog` prompt; the other tools never re-ask once the session exists.
* **No rate-limiting** on the login endpoints. If ComfyUI is exposed directly
  — e.g. `--listen 0.0.0.0`, a published Docker port, or any host on the LAN
  reaching the ComfyUI port — **an attacker can brute-force the password**.
  Bind ComfyUI to `127.0.0.1` (or firewall the port) and keep an authenticated
  reverse proxy / SSO in front.

**Conserved protections** (not password-related): path confinement/allow-lists
for files and model paths, SFTP URL validation, the bulk-settings allow-list
(`[Terminal]`/`[Security]` rejected → no `shell_command` injection through
`POST /holaf/utilities/save-all-settings`), and command timeouts.

---

## Included Utilities

*   **Holaf Terminal:** A functional, floating terminal panel, accessible from the "Utilities" menu. It runs within the ComfyUI environment, giving you access to the correct Python virtual environment.
*   **Holaf Model Manager:** An interface to view, search, and manage models recognized by ComfyUI.
*   **Holaf Image Viewer:** A powerful, fast, database-driven image and metadata manager, including a non-destructive image editor.
*   **(Planned) Holaf Session Log:** A UI activity log to track all actions performed during the session.

---

## Installation

1.  Navigate to the ComfyUI custom nodes directory:
    ```bash
    cd ComfyUI/custom_nodes/
    ```

2.  Clone this repository:
    ```bash
    git clone https://github.com/grokuku/ComfyUI-Holaf-Utilities
    ```

3.  Install the required Python dependencies. Navigate into the new directory and use `pip`:
    ```bash
    cd ComfyUI-Holaf-Utilities
    pip install -r requirements.txt
    ```
    *Note: This will install packages like `pywinpty` on Windows to provide a full terminal experience.*

4.  Restart ComfyUI.

---

## Configuration & Usage

### First-Time Use (Terminal)

1.  After installation and restarting ComfyUI, click the **"Utilities"** button in the top menu bar, then select **"Terminal"**.
2.  On first run, the shared authentication prompt appears: enter and confirm a
    password (minimum **8 characters**). The backend saves its PBKDF2 hash to
    `config.ini` under `[Security] / password_hash` and logs you in directly.
    *   **On success,** the terminal connects immediately.
    *   **On failure (file permissions),** the prompt displays the generated
        hash and instructions: copy it into `config.ini` under `[Security]` and
        restart ComfyUI.
    *   The `config.ini` file is located in
        `ComfyUI/custom_nodes/ComfyUI-Holaf-Utilities/`.
    *   You can also generate the hash manually: run
        `python -m custom_nodes.ComfyUI-Holaf-Utilities` (see `__main__.py`)
        and paste the printed `password_hash` line into `config.ini` under
        `[Security]`.

### Normal Usage

1.  Click the **"Utilities"** menu to open a utility panel.
2.  The first protected tool asks for the password (once per browser session);
    afterwards every tool (Terminal, Nodes Manager, Blobby…) reuses the same
    session without asking again.
3.  You can show/hide the panel by clicking the menu item again.

---

## Tests

```bash
./run_tests.sh                 # pytest (nécessite aiohttp + pytest dans l'environnement)
PYTHON=/path/to/venv/bin/python ./run_tests.sh
```

Les tests couvrent l'authentification partagée (`tests/test_auth_session.py` :
minimum 8, cookie de session sans `Max-Age`, gardes des routes) et la
non-régression des protections qui ne sont pas des mots de passe. Le script
lance pytest depuis un répertoire temporaire : le `__init__.py` racine
est le point d'entrée de l'extension (il importe `server` de ComfyUI) et ne doit
pas être importé par pytest.

## Project Roadmap & Status

This document tracks the project's evolution, planned features, and identified bugs.

**Legend:**
*   `🐞 Active Bug`
*   `⏳ In Progress`
*   `💡 Planned / Roadmap`
*   `🔧 Technical Improvement / Refactor`
*   `✅ Completed`

---

### 🐞 Active Bugs

*   *(None currently identified)*

### ⏳ In Progress

*   *(None currently identified)*

### 💡 Roadmap

#### General System & New Tools

*   `💡` **New Tool: Session Log:** Add a new panel that will display a textual history of all user actions and system responses within the interface (e.g., "5 images deleted," "API Error," etc.), providing clear session traceability.
*   `💡` **Periodic Maintenance Worker:** Implement a background worker running hourly to clean up stale data (orphaned thumbnails, invalid database entries) and optimize the database, ensuring long-term performance.

#### Image Viewer

*   `🔧` **Real-time File Monitoring:** Replace the periodic database scan with active file system monitoring (via `watchdog`) for instant detection and display of new or deleted images.
*   `💡` **Automated Corrupted File Management:**
    *   Create a special `output/corrupted` folder.
    *   During scans, automatically move unreadable images (and their `.txt`/`.json` files) to this folder.
    *   Display `Corrupted` as a special filter in the UI, with an "Empty" button to purge the folder.
*   `💡` **Define Feature Actions:**
    *   **"Slideshow" Button:** Implement a slideshow mode.

#### Image Editor

*   `💡` **"Operations" Tab:** Implement an "Operations" tab with "Toggle Preview" and "Copy/Paste Settings" functionality.
*   `💡` **New Features:** Crop/Expand, White Balance, Vignette, Watermark Overlay.

---

### ✅ Completed Features (Selection)

*   `✅` **Massive Gallery Performance Overhaul:** Reworked the thumbnail loading mechanism to be non-blocking and debounced. The gallery now remains fluid and responsive even when scrolling through tens of thousands of images, preventing server overload.
*   `✅` **Dialog & Accessibility Overhaul:** All dialogs are now fully keyboard navigable. Simple dialogs use arrow keys for button selection, while the complex export dialog features advanced 2D-aware navigation for all controls.
*   `✅` **UI & Focus Management:** Fixed a critical z-index bug causing dialogs to appear behind the fullscreen view. Corrected a major usability issue where clicking on UI controls (sliders, checkboxes) would improperly block main keyboard shortcuts.
*   `✅` **Unsaved Changes Warning on Export:** The editor now prompts the user to save or discard changes before exporting an edited image, preventing accidental data loss.
*   `✅` **UI Bug Squashing Spree:** Corrected bugs related to editor visibility, unresponsive filter buttons, and filter label positioning for a cleaner, more reliable interface.
*   `✅` **State-Driven Architecture:** Major frontend refactor to use a central state manager, resulting in a highly responsive UI where filter changes are instant.
*   `✅` **Non-Blocking Toast Notifications:** Replaced blocking `alert()` and `confirm()` dialogs with a non-blocking, auto-hiding toast notification system.
*   `✅` **Folder Filter Enhancements:** Added "Invert" selection, per-folder "lock" icons, and an advanced reset dialog that respects locked folders.
*   `✅` **Full Filter Persistence:** All filter settings (search, folders, dates, lock state, etc.) are now correctly saved and restored between sessions.
*   `✅` **Export Workflow Fix:** Corrected a frontend/backend data mismatch that prevented workflows from being saved in exported images.
*   `✅` **Thumbnail & Gallery Fixes:** Corrected last-row justification, implemented instant thumbnail size/fit updates, and enabled spacebar to toggle selection.
*   `✅` **Editor & Fullscreen Previews:** Live editor previews now correctly apply to the active image in zoom and fullscreen modes.
*   `✅` **Differential Gallery Rendering:** Replaced full gallery redraws with a differential rendering engine for fluid, non-blocking filter changes and eliminated race conditions.
*   `✅` **Trashcan Feature:** Implemented "Delete" (move to `trashcan`), "Restore," and "Empty Trashcan" functionality.
*   `✅` **Metadata Tools:** Implemented "Extract/Inject Metadata" APIs and UI buttons.
*   `✅` **Major Backend/Frontend Refactor:** Split the codebase into logical modules for improved maintainability.

---
*This extension was developed by Gemini (AI Assistant), under the guidance of Holaf.*