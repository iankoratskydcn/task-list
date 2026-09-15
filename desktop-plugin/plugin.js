/**
 * Task List desktop plugin — owner-gated, manually-triggered backlog pane.
 *
 * Distinct from Kanban: nothing runs until the owner explicitly ticks the
 * checkbox next to an item. Backend: ~/.hermes/plugins/task-list/ (SQLite,
 * driven via `hermes tasklist ...` CLI through cli.exec — this pane never
 * touches the DB file directly, same architecture as decision-hud).
 *
 * Layout: a single docked pane (right side, beside chat) — add box at top,
 * a plain list below with a checkbox per item. Clicking a row's title opens
 * a task EDITOR drawer (slides over the pane), modeled on Kanban's
 * TaskDrawer (apps/desktop/src/plugins/kanban/drawer.tsx): editable
 * title/body, a status control, timestamps, run result/error, and delete —
 * scaled down to this plugin's actual schema (no assignee/priority/
 * workspace/comments/dependencies/attachments; those are Kanban-only
 * concepts this plugin doesn't have a backend for). Built in raw
 * jsx()/jsxs() like the rest of this file and like decision-hud's plugin.js
 * — plugin-sdk's richer components (Section, Callout, DropdownMenu, ...)
 * are internal to the app's own bundled build and aren't available to a
 * loose plugin.js loaded via blob URL.
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

// Status control: mirrors Kanban's StatusMenu spirit (a compact control that
// shows current status and offers the valid next moves), scaled to this
// backend's actual transitions. pending/failed -> run(); running -> stop();
// no manual move into 'queued'/'done' (those are backend-driven).
function StatusControl({ task, onRun, onStop, busy }) {
  const label = STATUS_LABEL[task.status] || task.status
  const canRun = task.status === 'pending' || task.status === 'failed'
  const canStop = task.status === 'running'
  return jsxs('div', {
    className: 'flex items-center gap-2',
    children: [
      jsx('span', {
        className: cn(
          'rounded px-1.5 py-0.5 text-[0.7rem] font-medium',
          task.status === 'failed' && 'text-(--ui-danger,#e5484d)',
          task.status === 'done' && 'text-(--ui-success,#30a46c)',
          (task.status === 'running' || task.status === 'queued') && 'text-(--ui-text-secondary)',
          task.status === 'pending' && 'text-(--ui-text-tertiary)'
        ),
        children: label,
      }),
      canRun ? jsx('button', {
        type: 'button', onClick: () => onRun(task.id), disabled: busy,
        className: 'rounded border border-(--ui-stroke-secondary) px-2 py-0.5 text-[0.7rem] hover:bg-(--chrome-action-hover)',
        children: 'Trigger',
      }) : null,
      canStop ? jsx('button', {
        type: 'button', onClick: () => onStop(task.id), disabled: busy,
        className: 'rounded border border-(--ui-stroke-secondary) px-2 py-0.5 text-[0.7rem] hover:bg-(--chrome-action-hover)',
        children: 'Stop',
      }) : null,
    ],
  })
}

function fmtTime(unixSeconds) {
  if (!unixSeconds) return null
  try {
    return new Date(unixSeconds * 1000).toLocaleString()
  } catch (e) {
    return null
  }
}

// Small labeled-value row, mirrors Kanban drawer's MetaRow.
function MetaRow({ label, children }) {
  return jsxs(React.Fragment, {
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
      jsx('span', { className: 'min-w-0 truncate text-(--ui-text-secondary)', children }),
    ],
  })
}

// Editable title/body section, mirrors Kanban drawer's DescriptionSection:
// starts read-only, an edit toggle reveals inline inputs + a Save button.
function EditableFields({ task, onSave, disabled }) {
  const [editing, setEditing] = React.useState(false)
  const [title, setTitle] = React.useState(task.title)
  const [body, setBody] = React.useState(task.body)

  React.useEffect(() => {
    setTitle(task.title)
    setBody(task.body)
  }, [task.id, task.title, task.body])

  if (!editing) {
    return jsxs('div', {
      className: 'flex flex-col gap-1.5',
      children: [
        jsxs('div', {
          className: 'flex items-center justify-between gap-2',
          children: [
            jsx('div', { className: 'text-[0.7rem] font-medium text-(--ui-text-quaternary)', children: 'Goal / context' }),
            jsx('button', {
              type: 'button', onClick: () => setEditing(true), disabled,
              'aria-label': 'Edit',
              className: 'text-[0.7rem] text-(--ui-text-tertiary) hover:text-foreground',
              children: 'Edit',
            }),
          ],
        }),
        jsx('p', {
          className: 'whitespace-pre-wrap text-[0.8125rem] text-(--ui-text-secondary)',
          children: task.body || 'No goal/context set — falls back to the title when triggered.',
        }),
      ],
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('input', {
        type: 'text', value: title, onChange: (e) => setTitle(e.target.value),
        placeholder: 'Task title',
        className: 'w-full rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-sm',
      }),
      jsx('textarea', {
        value: body, onChange: (e) => setBody(e.target.value), rows: 4,
        placeholder: 'Goal/context for the agent when triggered',
        className: 'w-full resize-none rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs',
      }),
      jsxs('div', {
        className: 'flex justify-end gap-1.5',
        children: [
          jsx('button', {
            type: 'button', onClick: () => { setTitle(task.title); setBody(task.body); setEditing(false) },
            className: 'rounded px-2 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)',
            children: 'Cancel',
          }),
          jsx('button', {
            type: 'button',
            onClick: () => {
              const t = title.trim()
              if (!t) return
              onSave(t, body.trim())
              setEditing(false)
            },
            disabled: disabled || !title.trim(),
            className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 text-xs hover:bg-(--chrome-action-hover)',
            children: 'Save',
          }),
        ],
      }),
    ],
  })
}

// Task editor drawer — Kanban-drawer-inspired: header with status control +
// close/delete, editable title/body, meta timestamps, and a result/error
// panel once the task has run. Slides over the pane from the right, same
// visual language as Kanban's TaskDrawer (border-l, elevated bg, slide-in).
function TaskEditorDrawer({ task, onClose, onSave, onRun, onStop, onDelete, busy }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!task) return null

  return jsxs('div', {
    className: 'absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) duration-150 ease-out animate-in fade-in slide-in-from-right-4',
    children: [
      jsxs('header', {
        className: 'flex flex-col gap-2 border-b border-(--ui-stroke-tertiary) px-3 pt-3 pb-2.5',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(StatusControl, { task, onRun, onStop, busy }),
              jsx('div', { className: 'ml-auto flex items-center gap-1' }),
              jsx('button', {
                type: 'button', onClick: () => onDelete(task.id),
                'aria-label': 'Delete',
                className: 'grid size-6 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-danger,#e5484d)',
                children: '\u2715',
              }),
              jsx('button', {
                type: 'button', onClick: onClose,
                'aria-label': 'Close',
                className: 'grid size-6 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
                children: '\u2039',
              }),
            ],
          }),
          jsx('h2', {
            className: 'truncate text-sm leading-snug font-semibold text-foreground',
            children: task.title || task.id,
          }),
          jsx('span', {
            className: 'font-mono text-[0.625rem] text-(--ui-text-quaternary)',
            children: task.id,
          }),
        ],
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto p-3',
        children: jsxs('div', {
          className: 'flex flex-col gap-4 text-sm',
          children: [
            jsxs('div', {
              className: 'grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.71rem]',
              children: [
                fmtTime(task.created_at) ? jsx(MetaRow, { label: 'Created', children: fmtTime(task.created_at) }) : null,
                fmtTime(task.triggered_at) ? jsx(MetaRow, { label: 'Triggered', children: fmtTime(task.triggered_at) }) : null,
                fmtTime(task.completed_at) ? jsx(MetaRow, { label: 'Completed', children: fmtTime(task.completed_at) }) : null,
                task.pid ? jsx(MetaRow, { label: 'PID', children: String(task.pid) }) : null,
              ],
            }),
            jsx(EditableFields, {
              task,
              disabled: busy,
              onSave: (title, body) => onSave(task.id, title, body),
            }),
            task.result ? jsxs('div', {
              className: 'flex flex-col gap-1',
              children: [
                jsx('div', { className: 'text-[0.7rem] font-medium text-(--ui-text-quaternary)', children: 'Result' }),
                jsx('p', {
                  className: 'max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-(--ui-stroke-secondary) p-2 text-[0.75rem] text-(--ui-text-secondary)',
                  children: task.result,
                }),
              ],
            }) : null,
            task.error ? jsxs('div', {
              className: 'flex flex-col gap-1',
              children: [
                jsx('div', { className: 'text-[0.7rem] font-medium text-(--ui-text-quaternary)', children: 'Error' }),
                jsx('p', {
                  className: 'whitespace-pre-wrap rounded border border-(--ui-danger,#e5484d) p-2 text-[0.75rem] text-(--ui-danger,#e5484d)',
                  children: task.error,
                }),
              ],
            }) : null,
          ],
        }),
      }),
    ],
  })
}

function TaskRow({ task, onOpen, onRun, onDelete, busy }) {
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
      jsxs('button', {
        type: 'button',
        onClick: () => onOpen(task.id),
        className: 'min-w-0 flex-1 text-left',
        children: [
          jsx('div', {
            className: cn('truncate text-sm hover:underline', task.status === 'failed' && 'text-(--ui-danger,#e5484d)'),
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
  const [openId, setOpenId] = React.useState(null)

  const openTask = tasks.find((t) => t.id === openId) || null
  // If the open task falls out of the list (e.g. deleted, or archived after
  // a successful run) close the drawer instead of leaving it on stale data.
  React.useEffect(() => {
    if (openId && !openTask) setOpenId(null)
  }, [openId, openTask])

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

  const handleStop = React.useCallback(async (id) => {
    setBusy(true)
    try {
      await cliExec(['tasklist', 'stop', id, '--json'])
      host.notify({ kind: 'info', message: 'Stopped' })
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
      if (openId === id) setOpenId(null)
      await refresh()
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }, [refresh, openId])

  const handleSaveEdit = React.useCallback(async (id, title, body) => {
    setBusy(true)
    try {
      await cliExec(['tasklist', 'edit', id, '--title', title, '--body', body, '--json'])
      await refresh()
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return jsxs('div', {
    className: 'relative flex h-full flex-col gap-2 overflow-hidden',
    children: [
      jsxs('div', {
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
              : tasks.map((t) => jsx(TaskRow, {
                  key: t.id, task: t, onOpen: setOpenId, onRun: handleRun, onDelete: handleDelete, busy,
                })),
          }),
        ],
      }),
      openTask ? jsx(TaskEditorDrawer, {
        task: openTask,
        onClose: () => setOpenId(null),
        onSave: handleSaveEdit,
        onRun: handleRun,
        onStop: handleStop,
        onDelete: handleDelete,
        busy,
      }) : null,
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
