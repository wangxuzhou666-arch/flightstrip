// Reads the todos a session wrote itself with scripts/todo.mjs: <state dir>/todos/<sessionId>.json.
// When present they win (items and ticks are maintained by that session); Haiku only writes progress.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TodoItem } from '../shared/types.ts'
import { parseJsonLine } from './agents.ts'

const MAX_ITEMS = 12
const MAX_TEXT = 80

/** Never written, an empty list, or a corrupt file all return null: the strip falls back to Haiku's extracted todos */
export async function readSessionTodos(stateDir: string, sessionId: string): Promise<TodoItem[] | null> {
  let text: string
  try {
    text = await readFile(join(stateDir, 'todos', `${sessionId}.json`), 'utf8')
  } catch {
    return null
  }
  const items = parseJsonLine(text)?.items
  if (!Array.isArray(items)) return null
  const todos = items
    .filter((item): item is { text: string; done?: unknown } => typeof item?.text === 'string' && item.text.trim() !== '')
    .slice(0, MAX_ITEMS)
    .map((item) => ({ text: item.text.slice(0, MAX_TEXT), done: item.done === true }))
  return todos.length === 0 ? null : todos
}
