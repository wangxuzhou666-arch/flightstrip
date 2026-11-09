// Reads the todos a session wrote itself with scripts/todo.mjs: <state dir>/todos/<sessionId>.json.
// When present they win (items and ticks are maintained by that session); Haiku only writes progress.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TodoItem } from '../shared/types.ts'
import { parseJsonLine } from './agents.ts'

// todo.mjs keeps at most 12 unfinished items plus the 3 most recently finished
const MAX_ITEMS = 15
const MAX_TEXT = 80

export interface SessionTodos {
  items: TodoItem[]
  /** Finished items todo.mjs no longer lists (only the last few finished stay) */
  doneEarlier: number
}

/** Never written, an empty list, or a corrupt file all return null: the strip falls back to Haiku's extracted todos */
export async function readSessionTodos(stateDir: string, sessionId: string): Promise<SessionTodos | null> {
  let text: string
  try {
    text = await readFile(join(stateDir, 'todos', `${sessionId}.json`), 'utf8')
  } catch {
    return null
  }
  const saved = parseJsonLine(text)
  const items = saved?.items
  if (!Array.isArray(items)) return null
  const todos = items
    .filter((item): item is { text: string; done?: unknown } => typeof item?.text === 'string' && item.text.trim() !== '')
    .slice(0, MAX_ITEMS)
    .map((item) => ({ text: item.text.slice(0, MAX_TEXT), done: item.done === true }))
  if (todos.length === 0) return null
  const doneEarlier = saved?.doneEarlier
  // Files written before todo.mjs dropped finished items have no count
  return { items: todos, doneEarlier: typeof doneEarlier === 'number' && Number.isInteger(doneEarlier) && doneEarlier > 0 ? doneEarlier : 0 }
}
