# === Holaf Utilities - Terminal Manager ===
#
# Session lifecycle contract:
# - Every WebSocket connection spawns its OWN fresh PTY/shell.
#   There is deliberately no shared/singleton PTY: when a shell exits (Ctrl+D,
#   'exit', crash) the session is fully torn down and the next connection
#   always gets a brand-new, functional shell.
# - When the shell exits, the client first receives an explicit TEXT control
#   frame {"type": "session-ended"} before the WebSocket is closed, so the UI
#   can distinguish a clean end-of-session from a network drop.
# - Control messages travel as TEXT frames only ({resize, session-ended}); all
#   raw keyboard input travels as BINARY frames. This keeps user keystrokes
#   that happen to look like JSON from being swallowed by the control channel.
# - AUTH: NO application authentication. The pack ships no password mechanism;
#   access to this shell WebSocket is restricted by the reverse-proxy in front
#   of ComfyUI (Caddy basic_auth / Authentik). Never expose port 8188 directly.
import asyncio
import os
import platform
import shlex
import signal
import sys
import time
import json
import traceback
import threading

from aiohttp import web
# Conditional imports for PTY
IS_WINDOWS = platform.system() == "Windows"
if not IS_WINDOWS:
    try:
        import pty, termios, tty, fcntl, select, struct
    except ImportError:
        print("🔴 [Holaf-Terminal] Critical: pty/termios modules not found. Terminal will not work on non-Windows system.")
        pty = termios = tty = fcntl = select = struct = None 
else:
    try:
        from winpty import PtyProcess
    except ImportError:
        print("🔴 [Holaf-Terminal] Critical: 'pywinpty' is not installed. Terminal will not work on Windows.")
        print("   Please run 'pip install pywinpty' in your ComfyUI Python environment.")
        PtyProcess = None

# --- Terminal Environment ---
def is_running_in_conda():
    conda_prefix = os.environ.get('CONDA_PREFIX')
    return conda_prefix and sys.executable.startswith(os.path.normpath(conda_prefix))

def is_running_in_venv():
    venv_path = os.environ.get('VIRTUAL_ENV')
    return venv_path and sys.executable.startswith(os.path.normpath(venv_path))

# --- API Route Handlers ---
async def websocket_handler(request: web.Request, global_app_config):
    # NO application authentication: the pack ships no password mechanism.
    # Access to this shell WebSocket is restricted by the reverse-proxy in
    # front of ComfyUI (Caddy basic_auth / Authentik). The previous defense-in-
    # depth cookie check was removed together with the auth module.

    # NO timeout on the session: a terminal stays open indefinitely, including
    # through several minutes of a SILENT command (e.g. a HuggingFace model
    # download that prints nothing). The handler only returns when one of the
    # three concurrent tasks actually completes (client disconnect, shell exit,
    # or a send failure) — never because a fixed wall-clock ceiling elapsed.
    #
    # `heartbeat` sends periodic WebSocket PING frames (browsers auto-reply
    # PONG): this keeps the TCP connection alive through proxies/idle so a long
    # silent command cannot be killed by an intermediary idle timeout.
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    print("🟢 [Holaf-Terminal] WebSocket connection opened.")
    
    loop = asyncio.get_running_loop()
    pty_queue = asyncio.Queue() # For data from PTY to WebSocket
    
    proc_adapter = None # Will hold either WindowsPty or UnixPty instance

    # --- Idempotent PTY teardown (shared by the post-wait path and the finally) ---
    # Order matters: kill the shell first (force=True => SIGKILL on POSIX,
    # since interactive shells ignore SIGTERM), then collect the child so no
    # zombie/orphan remains, then release the master fd / ConPTY handles. The
    # boolean guard makes repeated calls (normal completion, exception, finally
    # safety net) harmless.
    pty_torn_down = False
    def _teardown():
        nonlocal pty_torn_down
        if pty_torn_down or not proc_adapter:
            return
        pty_torn_down = True
        try:
            if proc_adapter.is_alive():
                proc_adapter.terminate(force=True)
        except Exception:
            traceback.print_exc()
        try:
            reap = getattr(proc_adapter, 'reap', None)
            if reap:
                reap()   # Collect the child (no zombie/orphan shell).
        except Exception:
            traceback.print_exc()
        try:
            proc_adapter.close()  # Release the PTY master fd / ConPTY handles.
        except Exception:
            traceback.print_exc()
    
    try:
        user_shell = global_app_config['shell_command']
        shell_cmd_list = []
        current_env = os.environ.copy()

        if is_running_in_conda():
            conda_prefix = os.environ.get('CONDA_PREFIX')
            print(f"🔵 [Holaf-Terminal] Running in a Conda environment: {conda_prefix}")
            if IS_WINDOWS:
                inner_cmd = f'call conda activate "{conda_prefix}" 2>nul && {user_shell}'
                shell_cmd_list = ['cmd.exe', '/K', inner_cmd]
            else: # Linux/macOS
                cmd_string = f'eval "$(conda shell.bash hook)" && conda activate "{conda_prefix}" && exec {user_shell}'
                shell_cmd_list = ['/bin/bash', '-c', cmd_string]
        elif is_running_in_venv():
            print(f"🔵 [Holaf-Terminal] Running in a Venv environment: {os.environ.get('VIRTUAL_ENV')}")
            shell_cmd_list = shlex.split(user_shell)
        else:
            print(f"🔵 [Holaf-Terminal] Not in venv/conda. Using default shell for Python at: {sys.executable}")
            shell_cmd_list = shlex.split(user_shell)
            # Cleanse Conda vars if present but not active, to avoid issues
            if 'CONDA_PREFIX' in current_env:
                print("🔵 [Holaf-Terminal] Inherited Conda context detected. Cleansing environment.")
                for var_name in ['CONDA_PREFIX', 'CONDA_SHLVL', 'CONDA_DEFAULT_ENV', 'CONDA_PROMPT_MODIFIER']:
                    if var_name in current_env: del current_env[var_name]
        
        print(f"🔵 [Holaf-Terminal] Spawning shell with command: {shell_cmd_list}")

        if IS_WINDOWS:
            if not PtyProcess:
                await ws.close(code=1011, message=b'pywinpty library not found')
                return ws
            
            class WindowsPtyAdapter:
                # Per-connection adapter: one instance per WebSocket session.
                def __init__(self, p):
                    self.pty_proc = p
                    self._closed = False
                    self._read_supports_timeout = True # Lazily confirmed on first read().
                def read(self, size):
                    # FIX: the raw pywinpty read() blocks FOREVER if the child
                    # dies without releasing the ConPTY pipe, wedging the reader
                    # thread (and with it the whole session). Bound every read:
                    #  - preferred path: timeout-aware read, looping while the
                    #    process is alive (empty result == timeout expiry, NOT
                    #    EOF);
                    #  - fallback (old pywinpty signatures without `timeout`):
                    #    tiny reads interleaved with 50ms sleeps while
                    #    isalive() holds.
                    # b'' is returned ONLY once the process is dead, so the
                    # reader thread always interprets it as a genuine EOF.
                    while self._read_supports_timeout:
                        try:
                            data = self.pty_proc.read(size, timeout=0.1)
                        except TypeError:
                            self._read_supports_timeout = False # Old signature: use polling fallback.
                            break
                        except Exception:
                            return b'' # Handle/pipe already gone: treat as EOF.
                        if data:
                            return data.encode('utf-8', errors='replace')
                        if not self.pty_proc.isalive():
                            return b'' # Process died while idle: real EOF.
                        # Empty read == timeout expiry: keep waiting while alive.
                    # Polling fallback: bail out as soon as the process is dead.
                    buf = []
                    while self.pty_proc.isalive():
                        try:
                            chunk = self.pty_proc.read(256)
                        except Exception:
                            break # Read failure (handle closed): treat as EOF.
                        if chunk:
                            buf.append(chunk)
                            if sum(map(len, buf)) >= size:
                                break
                        else:
                            time.sleep(0.05) # No data yet: brief yield, re-check liveness.
                    return ''.join(buf).encode('utf-8', errors='replace')
                def write(self, data_bytes): return self.pty_proc.write(data_bytes.decode('utf-8', errors='ignore'))
                def set_winsize(self, rows, cols): self.pty_proc.setwinsize(rows, cols)
                def is_alive(self): return self.pty_proc.isalive()
                def terminate(self, force=False):
                    try:
                        self.pty_proc.terminate(force)
                    except Exception:
                        pass
                def close(self):
                    # pywinpty owns the conpty handles; terminate() releases them.
                    self._closed = True
                def reap(self):
                    # pywinpty reaps internally via wait() in isalive()/terminate().
                    pass
            
            proc_adapter = WindowsPtyAdapter(PtyProcess.spawn(shell_cmd_list, dimensions=(24, 80), env=current_env))
        
        else: # Linux/macOS
            if not pty: # pty modules failed to import
                await ws.close(code=1011, message=b'pty/termios modules unavailable')
                return ws

            pid, fd = pty.fork()
            if pid == 0: # Child process
                os.environ["TERM"] = "xterm" # Basic terminal type
                try:
                    os.execvpe(shell_cmd_list[0], shell_cmd_list, current_env)
                except FileNotFoundError: # Fallback if shell_cmd_list[0] is not found in PATH
                    os.execvpe("/bin/sh", ["/bin/sh"], current_env) 
                sys.exit(1) # Should not be reached
            
            class UnixPtyAdapter:
                # Per-connection adapter: one instance per WebSocket session.
                def __init__(self, p, f_descriptor):
                    self.pid = p
                    self.fd = f_descriptor
                    self._closed = False
                def read(self, size): return os.read(self.fd, size)
                def write(self, data_bytes): return os.write(self.fd, data_bytes)
                def set_winsize(self, rows, cols):
                    winsize = struct.pack('HHHH', rows, cols, 0, 0)
                    fcntl.ioctl(self.fd, termios.TIOCSWINSZ, winsize)
                def is_alive(self):
                    try:
                        os.kill(self.pid, 0)
                        return True
                    except OSError:
                        return False
                def terminate(self, force=False):
                    # IMPORTANT: interactive shells (bash, zsh...) IGNORE SIGTERM
                    # by POSIX convention. The old implementation sent SIGTERM
                    # even with force=True, so the shell survived teardown, kept
                    # the PTY slave open and left the reader thread blocked in
                    # os.read() forever. force=True must be unconditionnally
                    # lethal: use SIGKILL.
                    try:
                        os.kill(self.pid, signal.SIGKILL if force else signal.SIGTERM)
                    except ProcessLookupError:
                        pass # Process already ended
                def close(self):
                    # Release the PTY master fd. Idempotent; safe to call twice
                    # (handler finally + reader thread). Only the first call
                    # actually closes it.
                    if not self._closed:
                        self._closed = True
                        try:
                            os.close(self.fd)
                        except OSError:
                            pass
                def reap(self):
                    # Collect the child so it does not linger as a zombie. Runs
                    # in the reader thread (off the event loop), so a short
                    # blocking wait is acceptable.
                    if self.pid is None:
                        return
                    deadline = time.monotonic() + 3.0
                    while time.monotonic() < deadline:
                        try:
                            pid, _status = os.waitpid(self.pid, os.WNOHANG)
                        except ChildProcessError:
                            return # Already reaped elsewhere
                        if pid == self.pid:
                            return # Collected
                        time.sleep(0.05)
                    # Still alive after grace period: unconditionnally kill.
                    try:
                        os.kill(self.pid, signal.SIGKILL)
                        os.waitpid(self.pid, 0)
                    except (ProcessLookupError, ChildProcessError, OSError):
                        pass
            
            # Set initial window size and terminal attributes for the PTY master
            initial_winsize_packed = struct.pack('HHHH', 24, 80, 0, 0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, initial_winsize_packed)
            
            # Set terminal to raw mode and enable echo
            attrs = termios.tcgetattr(fd)
            attrs[3] &= ~termios.ICANON  # Disable canonical mode
            attrs[3] |= termios.ECHO    # Enable echo
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            
            proc_adapter = UnixPtyAdapter(pid, fd)

        # --- Reader thread (PTY -> queue) ---
        def pty_reader_thread_target():
            try:
                while proc_adapter and proc_adapter.is_alive():
                    data = proc_adapter.read(1024) # Read up to 1KB
                    if not data: # PTY closed
                        break
                    loop.call_soon_threadsafe(pty_queue.put_nowait, data)
            except (OSError, IOError, EOFError):
                pass # Expected when the PTY closes (EIO/EBADF after child death)
            finally:
                try:
                    if proc_adapter:
                        proc_adapter.reap()   # No zombie child left behind.
                        proc_adapter.close()  # Release the PTY master fd.
                except Exception:
                    traceback.print_exc()
                # Signal completion to the event loop LAST, so the WebSocket
                # closes promptly for the user while reaping happens quietly.
                loop.call_soon_threadsafe(pty_queue.put_nowait, None)
                if not thread_done.done():
                    loop.call_soon_threadsafe(thread_done.set_result, None)

        # Dedicated DAEMON thread (not asyncio.to_thread): the default executor
        # has a hard worker cap, and a reader stuck on a dying PTY used to
        # permanently consume one worker per session. Once the pool was
        # exhausted, new sessions never got a reader -> "dead terminal" after
        # re-login. A per-session daemon thread cannot poison a shared pool and
        # does not block interpreter shutdown.
        reader_thread = threading.Thread(
            target=pty_reader_thread_target,
            name=f"holaf-terminal-pty-reader-{id(ws)}",
            daemon=True,
        )
        thread_done = loop.create_future() # Async view of the thread's exit

        # --- Sender task (queue -> WebSocket) ---
        async def pty_to_ws_sender():
            session_ended = False
            while True:
                data = await pty_queue.get()
                if data is None: # EOF signal: the shell exited / PTY closed
                    session_ended = True
                    break
                try:
                    await ws.send_bytes(data)
                except ConnectionResetError:
                    break # Client disconnected
            if not ws.closed:
                if session_ended:
                    # Explicit control frame so the UI can return to the login
                    # screen with a clean state instead of guessing from the
                    # bare close event.
                    try:
                        await ws.send_str(json.dumps({"type": "session-ended"}))
                    except Exception:
                        pass # Client already gone; close below still applies.
                try:
                    await ws.close()
                except Exception:
                    pass

        # FIX: Create explicit Tasks for all three concurrent operations.
        # Old code used `asyncio.gather()` with all three, but when the client
        # disconnected, the PTY reader thread (blocked on os.read) and the sender
        # task (blocked on queue.get) could never complete because the PTY was
        # only terminated in the `finally` block AFTER `gather()` returned → deadlock.
        sender_task = asyncio.create_task(pty_to_ws_sender())

        # Task to receive data from WebSocket and write to PTY
        async def ws_to_pty_receiver():
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    try:
                        data_json = json.loads(msg.data)
                        if 'resize' in data_json and isinstance(data_json['resize'], list) and len(data_json['resize']) == 2:
                            rows, cols = data_json['resize']
                            if proc_adapter: proc_adapter.set_winsize(rows, cols)
                            print(f"🔵 [Holaf-Terminal] Resized to {rows}x{cols}")
                        # Could handle other JSON commands here
                    except (json.JSONDecodeError, TypeError):
                        # Not JSON, assume it's direct input for the terminal
                        if proc_adapter: proc_adapter.write(msg.data.encode('utf-8'))
                elif msg.type == web.WSMsgType.BINARY:
                    if proc_adapter: proc_adapter.write(msg.data)
                elif msg.type == web.WSMsgType.ERROR:
                    print(f'🔴 [Holaf-Terminal] WebSocket error: {ws.exception()}')
                    break

        receiver_task = asyncio.create_task(ws_to_pty_receiver())

        # Arm the reader thread last so it cannot signal an empty room.
        reader_thread.start()

        # FIX: Wait for ANY task to finish (client disconnect, PTY exit, or error),
        # then terminate the PTY and close the WebSocket to unblock remaining
        # tasks. There is deliberately NO `timeout=` here: this handler used to
        # carry a 300s "stall ceiling" that force-killed the PTY whenever no
        # task had completed within 5 minutes — which is exactly what a silent
        # multi-minute download looks like (reader blocked in os.read, receiver
        # idle, nothing to send). That ceiling closed the terminal mid-download
        # and forced the user to reconnect. Removing it makes the session live
        # as long as the user keeps it open (shell exit still ends it cleanly).
        _, pending = await asyncio.wait(
            [sender_task, receiver_task, thread_done],
            return_when=asyncio.FIRST_COMPLETED
        )

        # Terminate/reap/close the PTY to unblock the reader thread. force=True
        # must be lethal: interactive shells ignore SIGTERM, which used to leave
        # them alive and the reader thread blocked forever.
        _teardown()

        # Close WebSocket to unblock the receiver task if it's still running
        if not ws.closed:
            try:
                await ws.close()
            except Exception:
                pass

        # Wait for remaining tasks to finish cleanup (with timeout)
        for task in pending:
            try:
                await asyncio.wait_for(task, timeout=3.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                if not task.done():
                    task.cancel()

    except Exception as e:
        print(f"🔴 [Holaf-Terminal] Unhandled error in WebSocket PTY handler: {e}")
        traceback.print_exc()
    finally:
        print("⚫ [Holaf-Terminal] Cleaning up PTY session.")
        # Safety net: whatever happened above (exception, client disconnect,
        # shell exit), ensure the PTY process dies, the child is reaped and the
        # master fd released so the next login always gets a fresh session.
        # Idempotent: no-op if teardown already ran post-wait.
        # (proc_adapter/_teardown/ws are pre-initialized before the try block,
        # so no NameError is possible here.)
        _teardown()
        try:
            if not ws.closed:
                await ws.close()
        except (NameError, AttributeError):
            pass
    
    return ws