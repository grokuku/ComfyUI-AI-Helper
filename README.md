# Holaf Utilities for ComfyUI.

## 🚨 ***EXTREMELY IMPORTANT SECURITY WARNING*** 🚨

**This custom extension provides powerful tools, including a web terminal (shell) interface, to the machine running the ComfyUI server. By installing and using this extension, you are opening a direct and potentially dangerous access point to your system.**

**USE THIS EXTENSION AT YOUR OWN RISK. THE AUTHOR(S) ARE NOT RESPONSIBLE FOR ANY DAMAGE, DATA LOSS, OR SECURITY BREACHES THAT MAY RESULT FROM ITS USE.**

---

### Before you proceed, you MUST understand:

1.  **Remote Code Execution:** The Terminal utility is designed to execute shell commands on your server from a web browser. If your ComfyUI is accessible on a network (even a local one), anyone who can access the ComfyUI web page could potentially take control of your server.
2.  **Network Security:** **DO NOT EXPOSE** your ComfyUI instance to the public internet (e.g., using `--listen 0.0.0.0`) with this extension installed, unless you have secured it behind a robust authentication layer (like a reverse proxy with a login/password) and are using **HTTPS**.
3.  **NO application authentication — the pack ships NO password.** Access
    control is delegated entirely to a reverse proxy placed IN FRONT of
    ComfyUI (e.g. Caddy `basic_auth`, or Authentik forward-auth). ⚠️ **NEVER
    expose the ComfyUI port (8188) directly** — doing so bypasses the proxy
    protection and leaves the shell/RCE endpoints wide open on the network.
4.  **Intended Use:** This tool is intended for advanced users who need to perform system maintenance (manage files, update repositories, monitor processes with `nvidia-smi`) on a remote or headless ComfyUI server without needing a separate SSH session.

**If you do not understand these risks, DO NOT INSTALL THIS EXTENSION.**

---

### 🔐 Security posture: no application authentication (delegated to the reverse proxy)

**This pack contains NO password mechanism, no session cookie and no route
guard.** By explicit product decision (*"zero password — security only via
Caddy + Authentik"*), all access control is performed **upstream of the pack**,
by the reverse proxy in front of the ComfyUI host:

* Recommended barrier: **Caddy `basic_auth`** (or **Authentik forward-auth**)
  protecting the whole ComfyUI host.
* ⚠️ **Deployment rule: NEVER expose port 8188 directly** (no `--listen
  0.0.0.0` on a reachable network, no published Docker port bypassing the
  proxy). If the ComfyUI port is reachable without going through the proxy,
  every protection below is void.

The following endpoints are **sensitive** and rely **entirely** on the reverse
proxy (there is no local-only exemption and no application-level guard):

* `GET /holaf/terminal` (WebSocket) — interactive **shell (RCE)**.
* `POST /aih/blobby/exec` — **shell (RCE)** (15 s hard timeout; no application
  guard).
* `POST /api/aih/custom-nodes/install` — `git` clone + `pip`-able node install.
* `POST /holaf/nodes/install`, `/holaf/nodes/update`, `/holaf/nodes/delete`,
  `/holaf/nodes/install-requirements` — `git`/`pip` operations on custom nodes.
* `POST /aih/update` — `git fetch` + `git reset --hard` on the pack.
* `POST /holaf/utilities/restart` — restarts the ComfyUI server.
* `POST /holaf/models/upload-chunk`, `/holaf/models/finalize-upload`,
  `/holaf/models/delete`, `/holaf/models/deep-scan-local` — model upload /
  delete / deep scan.
* `GET/POST /aih/credentials`, `GET/POST /aih/openai/keys` — read/write local
  credentials (API key, server URL, OpenAI keys).
* `POST/GET /aih/blobby/save`, `/aih/blobby/load` — companion settings.

Because the pack runs in a trusted LAN behind Authentik, this trade-off is
assumed by the product owner. The pack still ships the following **non-auth
defenses** (kept intact): path confinement / allow-lists for files and model
paths, SFTP URL validation, refusal of `git` URLs containing credentials, a
15 s command timeout on `blobby/exec`, and the bulk-settings allow-list
(`[Terminal]`/`[Security]` rejected → no `shell_command` injection through
`POST /holaf/utilities/save-all-settings`).

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
    git clone https://github.com/grokuku/ComfyUI-AI-Helper
    ```

3.  Install the required Python dependencies. Navigate into the new directory and use `pip`:
    ```bash
    cd ComfyUI-AI-Helper
    pip install -r requirements.txt
    ```
    *Note: This will install packages like `pywinpty` on Windows to provide a full terminal experience.*

    > The pack's historical folder name was `ComfyUI-Holaf-Utilities`. If an old
    > `custom_nodes/ComfyUI-Holaf-Utilities` (or `ComfyUI-Holaf`) folder is still
    > present next to this one and you do not need it, DELETE it manually:
    > keeping both makes ComfyUI load two copies of the front-end scripts (the
    > stale Model Browser JS then overwrites the current one).
    >
    > This pack NEVER modifies those folders: it only logs a warning when it finds
    > PROOF that another loadable folder still serves an old copy of its own
    > Model Browser JS (a file without the `AIH_MB_BUILD` marker). The historical
    > names `ComfyUI-Holaf*` remain fully usable for future packs — nothing is
    > ever blocked, moved, renamed or quarantined based on a folder name.

4.  Restart ComfyUI.

---

## Configuration & Usage

### First-Time Use (Terminal)

1.  After installation and restarting ComfyUI, make sure the host is behind
your reverse proxy (Caddy `basic_auth` or Authentik) — the pack itself asks
for no password.
2.  Click the **"Utilities"** button in the top menu bar, then select
**"Terminal"**. The terminal connects immediately (no prompt).

### Normal Usage

1.  Click the **"Utilities"** menu to open a utility panel.
2.  Every tool (Terminal, Blobby, Model Manager, Nodes Manager…) opens directly;
    no password is ever requested. Access is enforced by the reverse proxy.
3.  You can show/hide the panel by clicking the menu item again.

---

## Tests

```bash
./run_tests.sh                 # pytest (nécessite aiohttp + pytest dans l'environnement)
PYTHON=/path/to/venv/bin/python ./run_tests.sh
```

Les tests couvrent l'ABSENCE d'authentification applicative
(`tests/test_no_password.py` : aucun module d'auth, aucune route gardée —
balayage AST —, le WebSocket terminal se connecte sans cookie), l'upload de
modèles sans cookie (`tests/test_model_upload_no_auth.py`) et la
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