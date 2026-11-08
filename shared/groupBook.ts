// Groups you create yourself: you type the name, move a session into a group from its card, and sessions not
// picked count as "ungrouped".
// groups is the ordered list of groups, members maps sessionId → group id, ungroupedAt is the position "ungrouped" sits
// at (it can be dragged too: with a single custom group, the only reordering possible is that group against "ungrouped").
// This is only the state and the rules of every change to it. Storage is the caller's: server/groups.ts saves it to
// groups.json, the static demo build (client/src/staticDemo.ts) keeps it in memory.
import { ActionError } from './actionError.ts'
import type { Translate } from './i18n/index.ts'
import type { SessionGroup } from './types.ts'

const NAME_LIMIT = 30
const GROUP_LIMIT = 30
const ID_PATTERN = /^g[0-9a-f]{8}$/
/** The code for "ungrouped" in the ordering; same as UNGROUPED in the client's Groups.tsx */
const UNGROUPED = 'none'

export interface GroupState {
  groups: SessionGroup[]
  members: Record<string, string>
  ungroupedAt: number
}

export class GroupBook {
  state: GroupState = { groups: [], members: {}, ungroupedAt: 0 }

  /** `t` is called when an error is worded, so it follows the language of the moment (the server's serverT does) */
  constructor(private readonly t: Translate) {}

  get groups(): SessionGroup[] {
    return this.state.groups
  }

  get ungroupedAt(): number {
    return this.state.ungroupedAt
  }

  /** Which group the session is in; null if that group was deleted or it was never grouped */
  groupOf(sessionId: string): string | null {
    const id = this.state.members[sessionId]
    return id !== undefined && this.state.groups.some((group) => group.id === id) ? id : null
  }

  private cleanName(raw: unknown, exceptId: string | null): string {
    const name = String(raw ?? '').trim()
    if (name === '' || name.length > NAME_LIMIT || /[\r\n]/.test(name)) {
      throw new ActionError(400, this.t('error.groupName', { max: NAME_LIMIT }))
    }
    if (this.state.groups.some((group) => group.name === name && group.id !== exceptId)) throw new ActionError(409, this.t('error.groupExists', { name }))
    return name
  }

  private indexOf(rawId: unknown): number {
    const id = String(rawId ?? '')
    const index = ID_PATTERN.test(id) ? this.state.groups.findIndex((group) => group.id === id) : -1
    if (index === -1) throw new ActionError(404, this.t('error.groupGone'))
    return index
  }

  /** Creates a group; with a sessionId, also moves that session in ("New group…" on a card takes this path) */
  create(rawName: unknown, sessionId: string | null): string {
    if (this.state.groups.length >= GROUP_LIMIT) throw new ActionError(409, this.t('error.groupLimit', { max: GROUP_LIMIT }))
    const name = this.cleanName(rawName, null)
    const id = `g${Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    this.state.groups.push({ id, name })
    if (sessionId !== null) this.state.members[sessionId] = id
    return id
  }

  rename(rawId: unknown, rawName: unknown): void {
    const group = this.state.groups[this.indexOf(rawId)]
    group.name = this.cleanName(rawName, group.id)
  }

  /** Deleting a group removes only the group itself; its sessions go back to ungrouped */
  remove(rawId: unknown): void {
    const index = this.indexOf(rawId)
    if (index < this.state.ungroupedAt) this.state.ungroupedAt -= 1
    const [removed] = this.state.groups.splice(index, 1)
    for (const [sessionId, id] of Object.entries(this.state.members)) {
      if (id === removed.id) delete this.state.members[sessionId]
    }
  }

  /** Moves a group (or "ungrouped") before `before`; before = null moves it to the end. Dragging a group header and
   *  arrow keys on it both come through here. Uses "move before whom" instead of "move to position N": "ungrouped" is
   *  hidden while it has no sessions, so positions on the page don't match the ones here */
  move(rawId: unknown, rawBefore: unknown): void {
    const order = this.state.groups.map((group) => group.id)
    order.splice(this.state.ungroupedAt, 0, UNGROUPED)
    const id = String(rawId ?? '')
    if (!order.includes(id)) throw new ActionError(404, this.t('error.groupGone'))
    const rest = order.filter((other) => other !== id)
    const at = rawBefore === null ? rest.length : rest.indexOf(String(rawBefore))
    if (at === -1) throw new ActionError(404, this.t('error.moveTargetGone'))
    rest.splice(at, 0, id)
    const byId = new Map(this.state.groups.map((group) => [group.id, group]))
    this.state.ungroupedAt = rest.indexOf(UNGROUPED)
    this.state.groups = rest.flatMap((other) => byId.get(other) ?? []) // "ungrouped" isn't a real group, so it is filtered out here
  }

  /** Puts a session into a group; groupId = null moves it back to ungrouped */
  assign(sessionId: string, rawGroupId: unknown): void {
    if (rawGroupId === null) {
      delete this.state.members[sessionId]
    } else {
      this.state.members[sessionId] = this.state.groups[this.indexOf(rawGroupId)].id
    }
  }
}
