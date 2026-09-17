"""Task List — spawn/sync a triggered item as a detached one-shot Hermes agent.

Trigger: `hermes -p <agent> -m <model> -z <body> --yolo` as a DETACHED background process (start_new_session
so it survives the CLI invocation that triggered it exiting), stdout/stderr redirected
to a per-task log file under plugin-data/task-list/logs/<id>.log. `run()` marks the row
'running' with the child pid and returns immediately — it does not block.

Reconciliation: nothing polls automatically (this plugin has no daemon). `sync()` — called
by `hermes tasklist list`/`sync`, and by the desktop pane's poll loop via cli.exec — checks
every 'running' row's pid with os.kill(pid, 0); a dead pid means the process exited, so sync
reads the log file back as the result and calls mark_finished(). Exit code isn't captured
directly (a detached process's return code isn't observable after the parent forgets it);
the heuristic is: a non-empty, non-error-shaped final log tail is treated as success unless
the log file is entirely empty (spawn/crash-before-output) or missing, which is 'failed'.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional

try:
    from . import db
except ImportError:
    import sys as _sys
    from pathlib import Path as _Path
    _plugin_dir = str(_Path(__file__).resolve().parent)
    if _plugin_dir not in _sys.path:
        _sys.path.insert(0, _plugin_dir)
    import db  # type: ignore[import-not-found]


def _log_dir() -> Path:
    d = db.get_hermes_home() / "plugin-data" / "task-list" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _log_path(task_id: str) -> Path:
    return _log_dir() / f"{task_id}.log"


def _hermes_executable() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    return sys.executable  # dev fallback; unusual outside a proper install


def trigger(task_id: str) -> dict:
    """Spawn the item's body as a detached one-shot agent. Returns the updated row.

    Raises ValueError for an unknown id or a row that isn't 'pending'/'failed'
    (re-triggering something already queued/running/done is refused, not silently
    restarted — the owner deletes+re-adds or explicitly retries a failed row).
    """
    task = db.get_task(task_id)
    if task is None:
        raise ValueError(f"No task with id {task_id!r}")
    if task["status"] not in ("pending", "failed"):
        raise ValueError(
            f"Task {task_id!r} is {task['status']!r}; only 'pending' or 'failed' items can be triggered."
        )
    if not task["body"]:
        raise ValueError(f"Task {task_id!r} has no body/goal text to run.")

    db.mark_queued(task_id)
    log_path = _log_path(task_id)
    log_fh = open(log_path, "w", encoding="utf-8")
    argv = [_hermes_executable()]
    if task.get("agent"):
        argv.extend(["-p", task["agent"]])
    if task.get("model"):
        argv.extend(["-m", task["model"]])
    argv.extend(["-z", task["body"], "--yolo"])
    kwargs = dict(stdout=log_fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, close_fds=True)
    if os.name == "posix":
        kwargs["start_new_session"] = True  # detach from this CLI invocation's process group
    else:
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0)
    proc = subprocess.Popen(argv, **kwargs)
    log_fh.close()
    db.mark_running(task_id, proc.pid)
    return db.get_task(task_id)


def _pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    # If we happen to be this pid's parent (same-process trigger+sync, as in a short-lived
    # CLI session or a test), a finished detached child sits as a zombie that os.kill(pid, 0)
    # reports as "alive" forever until reaped. Try a non-blocking reap first; ChildProcessError
    # means we're not the parent (the common case: trigger and sync run as separate `hermes`
    # invocations, and the OS already reparented/reaped an orphan), so fall through to kill().
    try:
        reaped_pid, _status = os.waitpid(pid, os.WNOHANG)
        if reaped_pid == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    except PermissionError:
        return True  # exists, owned by someone else — treat as alive
    return True


def _read_log_tail(task_id: str, max_chars: int = 4000) -> str:
    path = _log_path(task_id)
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-max_chars:] if len(text) > max_chars else text


def sync() -> list[dict]:
    """Reconcile every 'running' row against its pid; returns the rows that changed."""
    changed = []
    for task in db.list_tasks(include_archived=False):
        if task["status"] != "running":
            continue
        if _pid_alive(task["pid"]):
            continue
        tail = _read_log_tail(task["id"])
        if not tail.strip():
            db.mark_finished(task["id"], status="failed", error="Process exited with no output.")
        else:
            db.mark_finished(task["id"], status="done", result=tail)
        changed.append(db.get_task(task["id"]))
    return changed


def stop(task_id: str) -> dict:
    """Best-effort SIGTERM on a running item's pid; sync() reconciles the row after."""
    task = db.get_task(task_id)
    if task is None:
        raise ValueError(f"No task with id {task_id!r}")
    if task["status"] != "running" or not task["pid"]:
        raise ValueError(f"Task {task_id!r} is not running.")
    try:
        os.kill(task["pid"], signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass
    db.mark_finished(task_id, status="failed", error="Stopped by owner.")
    return db.get_task(task_id)
