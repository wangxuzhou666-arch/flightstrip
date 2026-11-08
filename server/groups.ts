// Groups you create yourself: you type the name, move a session into a group from its card, and sessions not
// picked count as "ungrouped".
// Stored in groups.json in the state dir: groups is the ordered list of groups, members maps sessionId → group id,
// ungroupedAt is the position "ungrouped" sits at (it can be dragged too: with a single custom group, the only
// reordering possible is that group against "ungrouped"). Only the dashboard writes it.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionGroup } from '../shared/types.ts'
import { ActionError } from './actions.ts'
import { config } from './config.ts'
import { DEMO_GROUPS } from './demo.ts'
import { serverT } from './lang.ts'

const GROUPS_FILE = join(config.stateDir, 'groups.json')
const NAME_LIMIT = 30
const GROUP_LIMIT = 30
const ID_PATTERN = /^g[0-9a-f]{8}$/
/** The code for "ungrouped" in the ordering; same as UNGROUPED in the client's Groups.tsx */
const UNGROUPED = 'none'

interface GroupsFile {
  groups: SessionGroup[]
  members: Record<string, string>
  ungroupedAt: number
}

let state: GroupsFile = { groups: [], members: {}, ungroupedAt: 0 }

export async function loadGroups(): Promise<void> {
  if (config.demo) {
    // Demo mode starts from the fixture groups and keeps every change in memory
    state = structuredClone(DEMO_GROUPS)
    return
  }
  if (!existsSync(GROUPS_FILE)) return
  const parsed = JSON.parse(await readFile(GROUPS_FILE, 'utf8')) as Partial<GroupsFile>
  const groups = parsed.groups ?? []
  // Earlier files have no ungroupedAt: back then "ungrouped" was pinned at the top
  state = { groups, members: parsed.members ?? {}, ungroupedAt: Math.min(parsed.ungroupedAt ?? 0, groups.length) }
}

async function save(): Promise<void> {
  if (config.demo) return
  await mkdir(config.stateDir, { recursive: true })
  const temp = `${GROUPS_FILE}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2))
  await rename(temp, GROUPS_FILE)
}

export function listGroups(): SessionGroup[] {
  return state.groups
}

export function ungroupedAt(): number {
  return state.ungroupedAt
}

/** Which group the session is in; null if that group was deleted or it was never grouped */
export function groupOf(sessionId: string): string | null {
  const id = state.members[sessionId]
  return id !== undefined && state.groups.some((group) => group.id === id) ? id : null
}

function cleanName(raw: unknown, exceptId: string | null): string {
  const name = String(raw ?? '').trim()
  if (name === '' || name.length > NAME_LIMIT || /[\r\n]/.test(name)) {
    throw new ActionError(400, serverT('error.groupName', { max: NAME_LIMIT }))
  }
  if (state.groups.some((group) => group.name === name && group.id !== exceptId)) throw new ActionError(409, serverT('error.groupExists', { name }))
  return name
}

function indexOf(rawId: unknown): number {
  const id = String(rawId ?? '')
  const index = ID_PATTERN.test(id) ? state.groups.findIndex((group) => group.id === id) : -1
  if (index === -1) throw new ActionError(404, serverT('error.groupGone'))
  return index
}

/** Creates a group; with a sessionId, also moves that session in ("New group…" on a card takes this path) */
export async function createGroup(rawName: unknown, sessionId: string | null): Promise<string> {
  if (state.groups.length >= GROUP_LIMIT) throw new ActionError(409, serverT('error.groupLimit', { max: GROUP_LIMIT }))
  const name = cleanName(rawName, null)
  const id = `g${randomBytes(4).toString('hex')}`
  state.groups.push({ id, name })
  if (sessionId !== null) state.members[sessionId] = id
  await save()
  return id
}

export async function renameGroup(rawId: unknown, rawName: unknown): Promise<void> {
  const group = state.groups[indexOf(rawId)]
  group.name = cleanName(rawName, group.id)
  await save()
}

/** Deleting a group removes only the group itself; its sessions go back to ungrouped */
export async function deleteGroup(rawId: unknown): Promise<void> {
  const index = indexOf(rawId)
  if (index < state.ungroupedAt) state.ungroupedAt -= 1
  const [removed] = state.groups.splice(index, 1)
  for (const [sessionId, id] of Object.entries(state.members)) {
    if (id === removed.id) delete state.members[sessionId]
  }
  await save()
}

/** Moves a group (or "ungrouped") before `before`; before = null moves it to the end. Dragging a group header and
 *  arrow keys on it both come through here. Uses "move before whom" instead of "move to position N": "ungrouped" is
 *  hidden while it has no sessions, so positions on the page don't match the ones here */
export async function moveGroup(rawId: unknown, rawBefore: unknown): Promise<void> {
  const order = state.groups.map((group) => group.id)
  order.splice(state.ungroupedAt, 0, UNGROUPED)
  const id = String(rawId ?? '')
  if (!order.includes(id)) throw new ActionError(404, serverT('error.groupGone'))
  const rest = order.filter((other) => other !== id)
  const at = rawBefore === null ? rest.length : rest.indexOf(String(rawBefore))
  if (at === -1) throw new ActionError(404, serverT('error.moveTargetGone'))
  rest.splice(at, 0, id)
  const byId = new Map(state.groups.map((group) => [group.id, group]))
  state.ungroupedAt = rest.indexOf(UNGROUPED)
  state.groups = rest.flatMap((other) => byId.get(other) ?? []) // "ungrouped" isn't a real group, so it is filtered out here
  await save()
}

/** Puts a session into a group; groupId = null moves it back to ungrouped */
export async function assignGroup(sessionId: string, rawGroupId: unknown): Promise<void> {
  if (rawGroupId === null) {
    delete state.members[sessionId]
  } else {
    state.members[sessionId] = state.groups[indexOf(rawGroupId)].id
  }
  await save()
}
