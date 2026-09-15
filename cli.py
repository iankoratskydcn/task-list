"""Task List — `hermes tasklist ...` CLI subcommands.

Thin argparse wrappers over db.py/run.py, JSON output by default for the desktop plugin
(cli.exec), human-readable text for bare interactive use (no --json).
"""

from __future__ import annotations

import json

try:
    from . import db, run
except ImportError:
    import sys as _sys
    from pathlib import Path as _Path
    _plugin_dir = str(_Path(__file__).resolve().parent)
    if _plugin_dir not in _sys.path:
        _sys.path.insert(0, _plugin_dir)
    import db  # type: ignore[import-not-found]
    import run  # type: ignore[import-not-found]


def _print(obj) -> None:
    print(json.dumps(obj, default=str))


def setup(p) -> None:
    """setup_fn passed to register_cli_command: receives the ALREADY-CREATED
    `tasklist` parser."""
    verbs = p.add_subparsers(dest="verb", required=True)

    v = verbs.add_parser("add", help="Add a pending item (never runs it)")
    v.add_argument("title")
    v.add_argument("--body", default="", help="Goal/context text handed to the agent when triggered")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_add)

    v = verbs.add_parser("edit", help="Edit a still-pending item's title/body")
    v.add_argument("id")
    v.add_argument("--title", default=None, help="New title (omit to leave unchanged)")
    v.add_argument("--body", default=None, help="New goal/context text (omit to leave unchanged)")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_edit)

    v = verbs.add_parser("list", help="List items (pending/queued/running/failed by default)")
    v.add_argument("--all", action="store_true", dest="include_archived", help="Include archived (done) items")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_list)

    v = verbs.add_parser("run", help="Trigger a pending or failed item — spawns a detached agent")
    v.add_argument("id")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_run)

    v = verbs.add_parser("sync", help="Reconcile running items against their process state")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_sync)

    v = verbs.add_parser("stop", help="Stop a running item")
    v.add_argument("id")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_stop)

    v = verbs.add_parser("show", help="Show one item, including result/error")
    v.add_argument("id")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_show)

    v = verbs.add_parser("delete", aliases=["rm"], help="Delete an item")
    v.add_argument("id")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_delete)

    v = verbs.add_parser("archive", help="Archive an item without running it")
    v.add_argument("id")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cmd_archive)


def _cmd_add(args) -> None:
    task = db.add_task(args.title, args.body)
    if args.json:
        _print(task)
    else:
        print(f"Added {task['id']}: {task['title']}")


def _cmd_edit(args) -> None:
    task = db.edit_task(args.id, title=args.title, body=args.body)
    if task is None:
        if args.json:
            _print({"error": "not found, or not editable (only 'pending' items can be edited)"})
        else:
            print("Not found, or not editable (only 'pending' items can be edited).")
        raise SystemExit(1)
    if args.json:
        _print(task)
    else:
        print(f"Edited {task['id']}: {task['title']}")


def _cmd_list(args) -> None:
    tasks = db.list_tasks(include_archived=args.include_archived)
    if args.json:
        _print(tasks)
        return
    if not tasks:
        print("(no items)")
        return
    for t in tasks:
        marker = {"pending": "[ ]", "queued": "[…]", "running": "[▶]", "done": "[x]", "failed": "[!]"}.get(
            t["status"], "[?]")
        print(f"{marker} {t['id'][:8]}  {t['title']}  ({t['status']})")


def _cmd_run(args) -> None:
    try:
        task = run.trigger(args.id)
    except ValueError as exc:
        if args.json:
            _print({"error": str(exc)})
        else:
            print(f"Error: {exc}")
        raise SystemExit(1)
    if args.json:
        _print(task)
    else:
        print(f"Triggered {task['id']} (pid {task['pid']})")


def _cmd_sync(args) -> None:
    changed = run.sync()
    if args.json:
        _print(changed)
    else:
        if not changed:
            print("(no changes)")
        for t in changed:
            print(f"{t['id'][:8]}  {t['title']}  -> {t['status']}")


def _cmd_stop(args) -> None:
    try:
        task = run.stop(args.id)
    except ValueError as exc:
        if args.json:
            _print({"error": str(exc)})
        else:
            print(f"Error: {exc}")
        raise SystemExit(1)
    if args.json:
        _print(task)
    else:
        print(f"Stopped {task['id']}")


def _cmd_show(args) -> None:
    task = db.get_task(args.id)
    if task is None:
        if args.json:
            _print({"error": "not found"})
        else:
            print("Not found.")
        raise SystemExit(1)
    if args.json:
        _print(task)
        return
    print(f"{task['title']} ({task['status']})")
    print(task["body"])
    if task["result"]:
        print("\n--- result ---\n" + task["result"])
    if task["error"]:
        print("\n--- error ---\n" + task["error"])


def _cmd_delete(args) -> None:
    ok = db.delete_task(args.id)
    if args.json:
        _print({"deleted": ok})
    else:
        print("Deleted." if ok else "Not found.")


def _cmd_archive(args) -> None:
    ok = db.archive_task(args.id)
    if args.json:
        _print({"archived": ok})
    else:
        print("Archived." if ok else "Not found.")
