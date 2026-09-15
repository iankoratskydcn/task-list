"""Task List backend plugin — registers `hermes tasklist ...` CLI commands.

See plugin.yaml for the overall architecture. Storage lives entirely in db.py's
SQLite table; run.py owns the spawn/sync process lifecycle.
"""

from __future__ import annotations

try:
    from . import cli as _cli
except ImportError:
    # pytest's default "prepend" collection mode imports this hyphenated
    # plugin directory's __init__.py as a bare top-level module with no
    # parent package context, breaking the relative import above. The
    # production plugin loader (hermes_cli/plugins_loader.py) always
    # constructs a real package context before exec, so the try branch
    # above succeeds unconditionally in production (mirrors decision-hud's
    # __init__.py, same underlying gap).
    import sys as _sys
    from pathlib import Path as _Path
    _plugin_dir = str(_Path(__file__).resolve().parent)
    if _plugin_dir not in _sys.path:
        _sys.path.insert(0, _plugin_dir)
    import cli as _cli  # type: ignore[import-not-found]


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tasklist",
        help="Owner-gated task list (add/list/run/sync/stop)",
        setup_fn=_cli.setup,
        description="Manually-triggered task backlog backing the Task List desktop pane.",
    )
