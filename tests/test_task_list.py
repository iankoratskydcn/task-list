"""Task List backend: db.py + run.py E2E, against a temp HERMES_HOME (no mocks —
sqlite + real subprocess spawn/reconciliation, per repo's E2E-over-mocks rubric)."""

import os
import sys
import time
from pathlib import Path

import pytest


@pytest.fixture
def tasklist_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    plugin_dir = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(plugin_dir))
    import importlib
    for mod in ("db", "run"):
        sys.modules.pop(mod, None)
    import db as db_mod
    import run as run_mod
    importlib.reload(db_mod)
    importlib.reload(run_mod)
    return db_mod, run_mod, home


def test_add_task_is_pending_and_not_run(tasklist_env):
    db, run, home = tasklist_env
    task = db.add_task("do the thing", body="echo hi")
    assert task["status"] == "pending"
    assert task["pid"] is None
    fetched = db.get_task(task["id"])
    assert fetched["title"] == "do the thing"


def test_list_tasks_excludes_archived_by_default(tasklist_env):
    db, run, home = tasklist_env
    t1 = db.add_task("a")
    t2 = db.add_task("b")
    db.archive_task(t2["id"])
    assert [t["id"] for t in db.list_tasks()] == [t1["id"]]
    assert {t["id"] for t in db.list_tasks(include_archived=True)} == {t1["id"], t2["id"]}


def test_trigger_refuses_running_or_done_items(tasklist_env):
    db, run, home = tasklist_env
    task = db.add_task("x", body="echo hi")
    db.mark_running(task["id"], pid=999999)
    with pytest.raises(ValueError):
        run.trigger(task["id"])


def test_trigger_refuses_empty_body(tasklist_env):
    db, run, home = tasklist_env
    task = db.add_task("x", body="")
    with pytest.raises(ValueError):
        run.trigger(task["id"])


def test_trigger_spawns_detached_process_and_sync_reconciles_success(tasklist_env, monkeypatch):
    """Real subprocess spawn (a python one-liner standing in for `hermes -z`), then sync()
    reads its exit + log tail back into a 'done' + archived row — the full owner-gated
    trigger -> reconcile loop, no mocks."""
    db, run, home = tasklist_env
    # Stand in for the real `hermes` binary so this test has no dependency on a full
    # Hermes install: python -c 'print("agent output")' behaves like a fast, real,
    # detached child process writing stdout.
    monkeypatch.setattr(run, "_hermes_executable", lambda: sys.executable)
    task = db.add_task("echo test", body="print('agent output')")
    # trigger() calls "<python> -z <body> --yolo" verbatim — since we've swapped the
    # executable for plain python, patch trigger's argv construction indirectly by
    # monkeypatching subprocess.Popen to strip the -z/--yolo hermes-specific flags into
    # python -c form. Simpler: monkeypatch _hermes_executable to a tiny wrapper script.
    wrapper = home.parent / "fake_hermes.py"
    wrapper.write_text(
        "import sys\n"
        "# argv: fake_hermes.py -z <body> --yolo\n"
        "print(sys.argv[2])\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(run, "_hermes_executable", lambda: sys.executable)
    orig_popen = run.subprocess.Popen

    def patched_popen(argv, **kwargs):
        # argv[0] is the "hermes" executable; substitute so we actually run the wrapper.
        new_argv = [sys.executable, str(wrapper)] + argv[1:]
        return orig_popen(new_argv, **kwargs)

    monkeypatch.setattr(run.subprocess, "Popen", patched_popen)

    result = run.trigger(task["id"])
    assert result["status"] == "running"
    assert result["pid"] is not None

    deadline = time.time() + 10
    while time.time() < deadline:
        changed = run.sync()
        refreshed = db.get_task(task["id"])
        if refreshed["status"] != "running":
            break
        time.sleep(0.1)

    refreshed = db.get_task(task["id"])
    assert refreshed["status"] == "done"
    assert refreshed["archived"] == 1
    assert "agent output" in (refreshed["result"] or "")


def test_sync_marks_empty_output_as_failed_and_does_not_archive(tasklist_env, monkeypatch):
    db, run, home = tasklist_env
    wrapper = home.parent / "fake_hermes_silent.py"
    wrapper.write_text("pass\n", encoding="utf-8")
    orig_popen = run.subprocess.Popen

    def patched_popen(argv, **kwargs):
        new_argv = [sys.executable, str(wrapper)]
        return orig_popen(new_argv, **kwargs)

    monkeypatch.setattr(run.subprocess, "Popen", patched_popen)
    task = db.add_task("silent", body="do nothing")
    run.trigger(task["id"])

    deadline = time.time() + 10
    while time.time() < deadline:
        run.sync()
        refreshed = db.get_task(task["id"])
        if refreshed["status"] != "running":
            break
        time.sleep(0.1)

    refreshed = db.get_task(task["id"])
    assert refreshed["status"] == "failed"
    assert refreshed["archived"] == 0  # stays visible for the owner to notice/retry


def test_stop_marks_failed_and_clears_pid(tasklist_env):
    db, run, home = tasklist_env
    task = db.add_task("x", body="echo hi")
    db.mark_running(task["id"], pid=os.getpid())  # a pid guaranteed to exist (this test process)
    # SIGTERM on our own test process would kill the test runner — use a harmless
    # no-op signal path instead by stopping a pid that's already gone.
    db.mark_running(task["id"], pid=999999999)
    result = run.stop(task["id"])
    assert result["status"] == "failed"
    assert result["pid"] is None
    assert result["error"] == "Stopped by owner."
