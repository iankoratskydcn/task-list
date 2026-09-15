"""Task List — shared SQLite backlog.

Owner-gated, manually-triggered task queue. Distinct from Kanban: nothing
runs until the owner explicitly triggers an item (`hermes tasklist run <id>`
or the desktop pane's checkbox). Triggering spawns a detached one-shot
Hermes agent process (`hermes -z <goal> --yolo`) — see run.py — and
`hermes tasklist sync` reconciles process exit status back into the row.

Single-writer-per-row in practice (one owner, one desktop pane, one CLI),
but SQLite WAL mode is used anyway for the same reason decision-hud uses it:
a desktop pane poll and a CLI invocation can overlap safely.

Schema (v1):
    id           TEXT PRIMARY KEY   (uuid4 hex)
    title        TEXT NOT NULL      (short label, shown in list views)
    body         TEXT NOT NULL      (goal/context handed to the spawned agent
                                      verbatim as the -z prompt)
    status       TEXT NOT NULL      (pending|queued|running|done|failed)
    created_at   REAL NOT NULL      (unix time)
    triggered_at REAL               (NULL until run() is called)
    completed_at REAL               (NULL until the spawned process exits)
    pid          INTEGER            (NULL, or the spawned process's pid while running)
    result       TEXT               (NULL, or the agent's final stdout text)
    error        TEXT               (NULL, or a failure message: nonzero exit,
                                      spawn failure, etc.)
    archived     INTEGER NOT NULL DEFAULT 0  (1 once auto-archived on completion —
                                      see sync(); archived rows are excluded from
                                      list_pending() but kept for history)
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

try:
    from hermes_constants import get_hermes_home
except ImportError:  # pragma: no cover - only when hermes core isn't importable (dev shell)
    def get_hermes_home() -> Path:
        return Path.home() / ".hermes"

_STATUSES = ("pending", "queued", "running", "done", "failed")


def _db_path() -> Path:
    d = get_hermes_home() / "plugin-data" / "task-list"
    d.mkdir(parents=True, exist_ok=True)
    return d / "tasks.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL,
                body         TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending',
                created_at   REAL NOT NULL,
                triggered_at REAL,
                completed_at REAL,
                pid          INTEGER,
                result       TEXT,
                error        TEXT,
                archived     INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()


def add_task(title: str, body: str = "") -> dict:
    """Add a pending item. Never runs anything — owner triggers separately."""
    init_db()
    row = {
        "id": uuid.uuid4().hex, "title": title.strip(), "body": body.strip(),
        "status": "pending", "created_at": time.time(), "triggered_at": None,
        "completed_at": None, "pid": None, "result": None, "error": None, "archived": 0,
    }
    with _connect() as conn:
        conn.execute(
            "INSERT INTO tasks (id, title, body, status, created_at, archived) "
            "VALUES (?, ?, ?, ?, ?, 0)",
            (row["id"], row["title"], row["body"], row["status"], row["created_at"]),
        )
        conn.commit()
    return row


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


def get_task(task_id: str) -> Optional[dict]:
    init_db()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_tasks(include_archived: bool = False) -> list[dict]:
    init_db()
    query = "SELECT * FROM tasks"
    if not include_archived:
        query += " WHERE archived = 0"
    query += " ORDER BY created_at ASC"
    with _connect() as conn:
        rows = conn.execute(query).fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_task(task_id: str) -> bool:
    init_db()
    with _connect() as conn:
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
    return cur.rowcount > 0


def archive_task(task_id: str) -> bool:
    init_db()
    with _connect() as conn:
        cur = conn.execute("UPDATE tasks SET archived = 1 WHERE id = ?", (task_id,))
        conn.commit()
    return cur.rowcount > 0


def mark_running(task_id: str, pid: int) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE tasks SET status = 'running', triggered_at = ?, pid = ? WHERE id = ?",
            (time.time(), pid, task_id),
        )
        conn.commit()


def mark_queued(task_id: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE tasks SET status = 'queued', triggered_at = ? WHERE id = ?",
                      (time.time(), task_id))
        conn.commit()


def mark_finished(task_id: str, *, status: str, result: str = None, error: str = None) -> None:
    """status must be 'done' or 'failed'. A successful ('done') run auto-archives — the
    pending list only ever shows work not yet done. A failed run stays VISIBLE (not
    archived) so the owner notices and can retry/inspect/delete it explicitly."""
    if status not in ("done", "failed"):
        raise ValueError(f"mark_finished status must be 'done' or 'failed', got {status!r}")
    archived = 1 if status == "done" else 0
    with _connect() as conn:
        conn.execute(
            "UPDATE tasks SET status = ?, completed_at = ?, result = ?, error = ?, "
            "pid = NULL, archived = ? WHERE id = ?",
            (status, time.time(), result, error, archived, task_id),
        )
        conn.commit()
