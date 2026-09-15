# Task List

Owner-gated task list plugin for Hermes: a durable backlog of items you add over time, where
nothing runs until you explicitly trigger it (tick the box / `hermes tasklist run <id>`).

Distinct from Kanban (which auto-dispatches and auto-decomposes) — this is a manual queue for
"do this later, when I say go." Triggering an item spawns a headless one-shot Hermes agent
(`hermes -z <prompt> --yolo`) as a detached background process; the CLI owns polling/completion
via `hermes tasklist sync`.

- **Backend:** `~/.hermes/plugins/task-list/` — SQLite-backed, driven through `hermes tasklist ...`
  CLI commands.
- **Frontend:** `desktop-plugin/plugin.js` — a docked pane that drives the backend via the generic
  `cli.exec` RPC, mirroring the [decision-hud](https://github.com/iankoratskydcn/decision-hud)
  plugin's architecture (no direct DB access from the pane).

## Setup

### Backend
Symlink (or copy) this repo's backend files into `~/.hermes/plugins/task-list/`:
```
ln -s <path to this repo>/__init__.py <path to this repo>/cli.py <path to this repo>/db.py \
      <path to this repo>/run.py <path to this repo>/plugin.yaml ~/.hermes/plugins/task-list/
```

### Desktop pane
Symlink the desktop plugin directory into the app's plugin root so edits hot-reload:
```
ln -s <path to this repo>/desktop-plugin "$HERMES_HOME/desktop-plugins/task-list"
```
(Windows: `mklink /D "%LOCALAPPDATA%\hermes\desktop-plugins\task-list" "<path to this repo>\desktop-plugin"`)

Then Command Palette → "Reload desktop plugins" to force the first load.

## Tests
```
cd <path to this repo>
python -m pytest tests/
```
