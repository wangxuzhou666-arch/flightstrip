// Groups you create yourself: you type the name, move a session into a group from its card, and sessions not
// picked count as "ungrouped".
// The state and the rules live in shared/groupBook.ts (the static demo build uses the same); this file adds the storage.
// Stored in groups.json in the state dir: groups is the ordered list of groups, members maps sessionId → group id,
// ungroupedAt is the position "ungrouped" sits at (it can be dragged too: with a single custom group, the only
// reordering possible is that group against "ungrouped"). Only the dashboard writes it.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEMO_GROUPS } from '../shared/demo.ts'
import { GroupBook, type GroupState } from '../shared/groupBook.ts'
import type { SessionGroup } from '../shared/types.ts'
import { config } from './config.ts'
import { serverT } from './lang.ts'

const GROUPS_FILE = join(config.stateDir, 'groups.json')

const book = new GroupBook(serverT)

export async function loadGroups(): Promise<void> {
  if (config.demo) {
    // Demo mode starts from the fixture groups and keeps every change in memory
    book.state = structuredClone(DEMO_GROUPS)
    return
  }
  if (!existsSync(GROUPS_FILE)) return
  const parsed = JSON.parse(await readFile(GROUPS_FILE, 'utf8')) as Partial<GroupState>
  const groups = parsed.groups ?? []
  // Earlier files have no ungroupedAt: back then "ungrouped" was pinned at the top
  book.state = { groups, members: parsed.members ?? {}, ungroupedAt: Math.min(parsed.ungroupedAt ?? 0, groups.length) }
}

async function save(): Promise<void> {
  if (config.demo) return
  await mkdir(config.stateDir, { recursive: true })
  const temp = `${GROUPS_FILE}.tmp`
  await writeFile(temp, JSON.stringify(book.state, null, 2))
  await rename(temp, GROUPS_FILE)
}

export function listGroups(): SessionGroup[] {
  return book.groups
}

export function ungroupedAt(): number {
  return book.ungroupedAt
}

/** Which group the session is in; null if that group was deleted or it was never grouped */
export function groupOf(sessionId: string): string | null {
  return book.groupOf(sessionId)
}

/** Creates a group; with a sessionId, also moves that session in ("New group…" on a card takes this path) */
export async function createGroup(rawName: unknown, sessionId: string | null): Promise<string> {
  const id = book.create(rawName, sessionId)
  await save()
  return id
}

export async function renameGroup(rawId: unknown, rawName: unknown): Promise<void> {
  book.rename(rawId, rawName)
  await save()
}

/** Deleting a group removes only the group itself; its sessions go back to ungrouped */
export async function deleteGroup(rawId: unknown): Promise<void> {
  book.remove(rawId)
  await save()
}

/** Moves a group (or "ungrouped") before `before`; before = null moves it to the end */
export async function moveGroup(rawId: unknown, rawBefore: unknown): Promise<void> {
  book.move(rawId, rawBefore)
  await save()
}

/** Puts a session into a group; groupId = null moves it back to ungrouped */
export async function assignGroup(sessionId: string, rawGroupId: unknown): Promise<void> {
  book.assign(sessionId, rawGroupId)
  await save()
}
