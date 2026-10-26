# Modal 1.5.1 — API Reference Cheat Sheet

> Version: 1.5.1 (2026-06-23)
> Source: https://modal.com/docs/guide/modal-1-0-migration

## ❌ Removed / Deprecated APIs (do NOT use)

| Old API | Status | Replacement |
|---|---|---|
| `modal.Mount.from_file()` | **REMOVED** in v1.0 | `Image.add_local_file()` |
| `modal.Mount.from_local_dir()` | **REMOVED** in v1.0 | `Image.add_local_dir()` |
| `mount=` param on `@app.function` | **REMOVED** in v1.0 | Add files to Image instead |
| `Image.copy_local_file()` | Deprecated | `Image.add_local_file()` |
| `Image.copy_local_dir()` | Deprecated | `Image.add_local_dir()` |
| `modal.gpu.H100()` | Deprecated | `gpu="H100"` (string) |
| `modal.gpu.A100(size="80GB")` | Deprecated | `gpu="A100-80GB"` (string) |
| `allow_concurrent_inputs=N` | Deprecated | `@modal.concurrent(max_inputs=N)` |
| `modal.web_endpoint()` | Deprecated | `modal.fastapi_endpoint()` |
| `keep_warm=` | Deprecated | `min_containers=` |
| `concurrency_limit=` | Deprecated | `max_containers=` |
| `container_idle_timeout=` | Deprecated | `scaledown_window=` |
| `.lookup()` | Deprecated | `.from_name()` + `.hydrate()` |
| `@modal.build` | Deprecated | Use `modal.Volume` instead |

## ✅ Current APIs (Modal 1.5.1)

### Images
```python
image = modal.Image.debian_slim(python_version="3.11")
image = image.add_local_file("local.txt", "/remote/path.txt")  # default: mount at runtime
image = image.add_local_file("local.txt", "/remote/path.txt", copy=True)  # copy into image layer
image = image.add_local_dir("local_dir/", "/remote/dir/")
image = image.add_local_python_source("my_module", copy=True)
image = image.apt_install("git", "aria2")
image = image.pip_install("package")
image = image.run_commands("echo hello")
image = image.run_function(my_func)
```

### Volumes
```python
vol = modal.Volume.from_name("my-vol", create_if_missing=True)

# Mount on a function
@app.function(volumes={"/cache": vol})
def f():
    # Read/write files at /cache/
    vol.commit()  # Persist changes
    vol.reload()  # Fetch latest changes from other containers

# Upload from local code (outside Modal)
with vol.batch_upload() as batch:
    batch.put_file("local.txt", "remote.txt")
    batch.put_directory("local_dir/", "remote_dir/")

# CLI commands
# modal volume create my-vol
# modal volume list
# modal volume ls my-vol
# modal volume put my-vol local.txt remote.txt
# modal volume get my-vol remote.txt local.txt
# modal volume rm my-vol remote.txt
```

### Classes
```python
@app.cls(gpu="L4", volumes={"/cache": vol}, scaledown_window=30)
@modal.concurrent(max_inputs=10)
class MyWorker:
    gpu_type: str = "L4"  # class variable

    @modal.enter(snap=True)  # Runs before snapshot
    def start(self): ...

    @modal.enter(snap=False)  # Runs after snapshot restore
    def restore(self): ...

    @modal.exit()
    def cleanup(self): ...

    @modal.method()  # Required for .remote() calls
    async def my_method(self, arg): ...

# Calling from another function:
worker = MyWorker()
result = await worker.my_method.remote.aio(arg)  # async
result = worker.my_method.remote(arg)  # sync
```

### Functions
```python
@app.function(gpu="L4", timeout=300)
def f(x): ...

# Web endpoints
@app.function()
@modal.asgi_app(label="my-app")
def gateway(): return web_app  # FastAPI app

# FastAPI endpoint on a class method
@modal.fastapi_endpoint(method="POST")
async def my_endpoint(self, data): ...
```

### GPUs (string format)
```python
gpu="L4"          # 24GB, $0.80/h
gpu="L40S"        # 48GB, $1.95/h
gpu="A100-80GB"   # 80GB, $2.50/h
gpu="H100"        # 80GB, $3.95/h
gpu="T4"          # 16GB
```

### Secrets
```python
secrets=[modal.Secret.from_name("my-secret")]
# CLI: modal secret create my-secret KEY=value
```

### Key behaviors
- Volume changes need `vol.commit()` to persist
- Volume changes from other containers need `vol.reload()` to be visible
- `.remote()` returns a sync result; `.remote.aio()` returns a coroutine
- `@modal.method()` is required on class methods for `.remote()` calls
- `Image.add_local_file()` without `copy=True` mounts at runtime (faster iteration)
- Background commits happen automatically every few seconds
```