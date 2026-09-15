/**
 * Task List desktop plugin — owner-gated, manually-triggered backlog pane.
 *
 * Distinct from Kanban: nothing runs until the owner explicitly ticks the
 * checkbox next to an item. Backend: ~/.hermes/plugins/task-list/ (SQLite,
 * driven via `hermes tasklist ...` CLI through cli.exec — this pane never
 * touches the DB file directly, same architecture as decision-hud).
 *
 * Layout: a single docked pane (right side, beside chat) — add box at top,
 * a plain list below with a checkbox per item. Ticking a checkbox calls
 * `hermes tasklist run <id>` (spawns a detached one-shot agent) and the
 * poll loop's `hermes tasklist sync` reconciles completion back in.
 */

import { cn, host, PALETTE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import * as React from 'react'

const PLUGIN_ID = 'task-list'
const PANE_ID = `${PLUGIN_ID}:pane`
const POLL_MS = 4000

async function cliExec(argv) {
  const res = await host.request('cli.exec', { argv, timeout: 30 })
  if (!res || res.blocked) {
    throw new Error((res && res.hint) || 'cli.exec blocked')
  }
  if (res.code !== 0) {
    throw new Error(`tasklist CLI exited ${res.code}: ${res.output || ''}`)
  }
  return parseTrailingJson(res.output || '')
}

// Mirrors decision-hud's parseTrailingJson: stdout can carry noise ahead of
// or after the JSON payload (warnings, cli.exec's stdout+stderr join), so a
// naive JSON.parse(output.trim()) is fragile — bracket-match the first
// complete top-level JSON value instead.
function parseTrailingJson(output) {
  const trimmed = output.trim()
  if (trimmed) {
    try {
      return JSON.parse(trimmed)
    } catch (e) {
      // fall through to bracket-matched extraction below
    }
  }
  for (let i = 0; i < output.length; i++) {
    const ch = output[i]
    if (ch !== '{' && ch !== '[') continue
    const close = ch === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < output.length; j++) {
      const c = output[j]
      if (inString) {
        if (escape) { escape = false }
        else if (c === '\\') { escape = true }
        else if (c === '"') { inString = false }
        continue
      }
      if (c === '"') { inString = true; continue }
      if (c === ch) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          try { return JSON.parse(output.slice(i, j + 1)) } catch (e) { break }
        }
      }
    }
  }
  return null
}

function useTaskList() {
  const [tasks, setTasks] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)

  const refresh = React.useCallback(async () => {
    try {
      // sync() first so a completed background run shows its terminal state
      // immediately rather than waiting for the next poll tick.
      await cliExec(['tasklist', 'sync', '--json']).catch(() => null)
      const rows = await cliExec(['tasklist', 'list', '--json'])
      setTasks(Array.isArray(rows) ? rows : [])
      setError(null)
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    refresh()
    const timer = setInterval(() => { if (!cancelled) refresh() }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [refresh])

  return { tasks, loading, error, refresh }
}

const STATUS_LABEL = {
  pending: 'pending', queued: 'queued…', running: 'running…', done: 'done', failed: 'failed',
}

function TaskRow({ task, onRun, onDelete, busy }) {
  const isTerminal = task.status === 'done' || task.status === 'failed'
  const checked = task.status === 'queued' || task.status === 'running' || task.status === 'done'
  const canRun = task.status === 'pending' || task.status === 'failed'
  return jsxs('div', {
    className: 'flex items-start gap-2 rounded border border-(--ui-stroke-secondary) px-2 py-1.5',
    children: [
      jsx('input', {
        type: 'checkbox',
        checked,
        disabled: !canRun || busy,
        onChange: () => { if (canRun) onRun(task.id) },
        className: 'mt-0.5 cursor-pointer',
        title: canRun ? 'Trigger this task' : STATUS_LABEL[task.status] || task.status,
      }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('div', {
            className: cn('truncate text-sm', task.status === 'failed' && 'text-(--ui-danger,#e5484d)'),
            children: task.title,
          }),
          jsxs('div', {
            className: 'text-[0.7rem] text-(--ui-text-tertiary)',
            children: [STATUS_LABEL[task.status] || task.status, task.error ? ` — ${task.error}` : ''],
          }),
        ],
      }),
      jsx('button', {
        type: 'button',
        onClick: () => onDelete(task.id),
        'aria-label': 'Delete',
        className: 'text-[0.7rem] text-(--ui-text-tertiary) hover:text-(--ui-danger,#e5484d)',
        children: '✕',
      }),
    ],
  })
}

function AddTaskForm({ onAdd, busy }) {
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')
  const submit = React.useCallback(() => {
    const t = title.trim()
    if (!t || busy) return
    onAdd(t, body.trim())
    setTitle('')
    setBody('')
  }, [title, body, busy, onAdd])
  return jsxs('div', {
    className: 'flex flex-col gap-1.5 rounded border border-(--ui-stroke-secondary) p-2',
    children: [
      jsx('input', {
        type: 'text', placeholder: 'Task title', value: title,
        onChange: (e) => setTitle(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) submit() },
        className: 'w-full rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-sm',
      }),
      jsx('textarea', {
        placeholder: 'Goal/context for the agent when triggered (optional — defaults to the title)',
        value: body, onChange: (e) => setBody(e.target.value), rows: 2,
        className: 'w-full resize-none rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs',
      }),
      jsx('button', {
        type: 'button', onClick: submit, disabled: busy || !title.trim(),
        className: 'self-end rounded border border-(--ui-stroke-secondary) px-2 py-1 text-xs hover:bg-(--chrome-action-hover)',
        children: 'Add',
      }),
    ],
  })
}

function TaskListPane() {
  const { tasks, loading, error, refresh } = useTaskList()
  const [busy, setBusy] = React.useState(false)

  const handleAdd = React.useCallback(async (title, body) => {
    setBusy(true)
    try {
      await cliExec(['tasklist', 'add', title, '--body', body || title, '--json'])
      host.notify({ kind: 'success', message: `Added: ${title}` })
      await refresh()
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const handleRun = React.useCallback(async (id) => {
    setBusy(true)
    try {
      await cliExec(['tasklist', 'run', id, '--json'])
      host.notify({ kind: 'success', message: 'Triggered' })
      await refresh()
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const handleDelete = React.useCallback(async (id) => {
    setBusy(true)
    try {
      await cliExec(['tasklist', 'delete', id, '--json'])
      await refresh()
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 overflow-y-auto p-2',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between',
        children: [
          jsx('div', { className: 'font-medium', children: 'Task List' }),
          jsx('div', {
            className: 'text-[0.7rem] text-(--ui-text-tertiary)',
            children: loading ? 'refreshing…' : `${tasks.length} pending`,
          }),
        ],
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      jsx(AddTaskForm, { onAdd: handleAdd, busy }),
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: tasks.length === 0
          ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'No pending items.' })
          : tasks.map((t) => jsx(TaskRow, { key: t.id, task: t, onRun: handleRun, onDelete: handleDelete, busy })),
      }),
    ],
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Task List',
  register(ctx) {
    ctx.register({
      id: PANE_ID,
      area: 'panes',
      title: 'Task List',
      data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, minWidth: '22rem' },
      render: () => jsx(TaskListPane, {}),
    })
    // No SIDEBAR_NAV_AREA entry: decision-hud's own comments document that a nav row
    // needs a matching ROUTES_AREA placeholder or clicking it just reveals whatever
    // chat sits behind an empty route. The palette command below is the proven
    // reveal-the-docked-pane path (host.revealPane targets a `panes` registration,
    // which is what PANE_ID is) — add a ROUTES_AREA placeholder + nav row later if a
    // sidebar entry point turns out to be worth the extra surface.
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'task-list.open',
        label: 'Task List: Show pane',
        keywords: ['task', 'todo', 'backlog', 'queue', 'pane'],
        run: () => host.revealPane(PANE_ID),
      },
    })
  },
}
