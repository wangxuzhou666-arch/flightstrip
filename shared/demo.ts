// Demo mode (`flightstrip --demo` / FLIGHTSTRIP_DEMO=1, and the static GitHub Pages build): fictional sessions for trying
// the dashboard without any Claude Code data, and for screenshots. Everything here is invented: the project is a
// made-up "acme-shop" shop.
//
// The fixtures are typed against types.ts, so a field added to AgentStrip fails the type check here instead of
// silently missing from the demo. Surface labels, the "waiting for you" prefix, group ids and the bay ordering are NOT
// duplicated here: board.ts adds them to the strips below, the same way collect.ts does for real sessions.
// The fixture text itself (names, goals, progress) is English and shown as is in both languages; only text that is page
// chrome, like the line after a retire in the demo, goes through the dictionary.
// It sits in shared/ and imports nothing from Node, because the browser build imports it too.
//
// Time: every timestamp is "minutes before BASE", where BASE follows the clock but snaps back every LOOP_MS. So running
// jobs and "waiting for 8 min" counters tick up while you watch, and a demo left open all day still looks fresh instead
// of drifting out of the 3-hour window.
import type { Translate } from './i18n/index.ts'
import type { AgentStrip, SessionGroup, UsageReading } from './types.ts'

const MINUTE = 60_000
const LOOP_MS = 12 * MINUTE
const STARTED_AT = Date.now()

/** Where Claude Code says the session runs; null = background session */
export type DemoEntrypoint = 'claude-vscode' | 'cli' | 'claude-desktop' | null

export interface DemoStrip extends Omit<AgentStrip, 'surface' | 'groupId'> {
  entrypoint: DemoEntrypoint
  /** What the session waits on (the value `claude agents` reports), when stateKind is 'needs'; `now` is then the question */
  waitingFor?: string
}

export const DEMO_GROUPS: { groups: SessionGroup[]; members: Record<string, string>; ungroupedAt: number } = {
  groups: [
    { id: 'g000a0001', name: 'Platform' },
    { id: 'g000a0002', name: 'Checkout' },
    { id: 'g000a0003', name: 'Docs' },
  ],
  members: {
    'de100001-7e57-4000-8000-000000000001': 'g000a0001',
    'de100002-7e57-4000-8000-000000000002': 'g000a0002',
    'de100003-7e57-4000-8000-000000000003': 'g000a0001',
    'de100004-7e57-4000-8000-000000000004': 'g000a0002',
    'de100005-7e57-4000-8000-000000000005': 'g000a0002',
    'de100006-7e57-4000-8000-000000000006': 'g000a0003',
  },
  // "Ungrouped" (the two background sessions) sits below the three groups
  ungroupedAt: 3,
}

const SESSION_IDS = Object.freeze({
  auth: 'de100001-7e57-4000-8000-000000000001',
  e2e: 'de100002-7e57-4000-8000-000000000002',
  node: 'de100003-7e57-4000-8000-000000000003',
  orders: 'de100004-7e57-4000-8000-000000000004',
  webhooks: 'de100005-7e57-4000-8000-000000000005',
  docs: 'de100006-7e57-4000-8000-000000000006',
  audit: 'de100007-7e57-4000-8000-000000000007',
  backfill: 'de100008-7e57-4000-8000-000000000008',
})

const DEMO_SESSION_IDS: ReadonlySet<string> = new Set(Object.values(SESSION_IDS))

const CWD = '~/projects/acme-shop'
const PROJECT = 'acme-shop'

// In-memory only, like every other demo write
const renamed = new Map<string, string>()
const stoppedAt = new Map<string, number>()

export function isDemoSession(sessionId: string): boolean {
  return DEMO_SESSION_IDS.has(sessionId)
}

export function renameDemoSession(sessionId: string, name: string): void {
  renamed.set(sessionId, name)
}

/** The demo's stand-in for `claude stop`: the session stops running, so retiring it sticks */
export function stopDemoSession(sessionId: string, now: number): void {
  stoppedAt.set(sessionId, now)
}

export function demoUsage(now: number): UsageReading {
  return {
    source: 'statusline',
    at: now - 40_000,
    week: { percent: 41, resetsAt: now + 3 * 24 * 60 * MINUTE + 2 * 60 * MINUTE },
    fiveHour: { percent: 27, resetsAt: now + 2 * 60 * MINUTE + 10 * MINUTE },
  }
}

function worktree(name: string, lastAt: number): AgentStrip['worktrees'][number] {
  return { path: `${CWD}/.claude/worktrees/${name}`, name, lastAt, exists: true }
}

function pullRequest(number: number, state: string, review: string | null, checks: 'pass' | 'fail' | 'pending'): NonNullable<AgentStrip['pr']> {
  return { number, url: `https://example.com/acme-shop/pull/${number}`, state, review, checks }
}

/** The one place the fixture strips are built; `now` is the real clock, `base` the looping one */
export function demoStrips(now: number, t: Translate): DemoStrip[] {
  const base = now - ((now - STARTED_AT) % LOOP_MS)
  const ago = (minutes: number): number => base - minutes * MINUTE
  const strips = buildStrips(now, ago)
  return strips.map((strip) => applyWrites(strip, t))
}

function applyWrites(strip: DemoStrip, t: Translate): DemoStrip {
  const name = renamed.get(strip.sessionId) ?? strip.name
  const stopped = stoppedAt.get(strip.sessionId)
  if (stopped === undefined) return { ...strip, name }
  return {
    ...strip,
    name,
    stateKind: 'idle',
    bay: 'done',
    now: t('demo.stopped'),
    stateSince: null,
    updatedAt: stopped,
    segments: strip.segments.map((segment) => ({ ...segment, to: Math.min(segment.to, stopped) })),
    jobs: strip.jobs.map((job) => (job.status === 'running' ? { ...job, status: 'stopped', endedAt: stopped, tail: null } : job)),
  }
}

function buildStrips(now: number, ago: (minutes: number) => number): DemoStrip[] {
  // The running job's output line advances every 20 seconds, then starts over like a new run
  const e2eStartedAt = ago(9)
  const specRun = Math.floor((now - e2eStartedAt) / 20_000) % 50 + 1

  return [
    {
      sessionId: SESSION_IDS.auth, shortId: 'de100001', kind: 'interactive', entrypoint: 'claude-vscode',
      name: 'Migrate auth to OAuth2', project: PROJECT, cwd: CWD, branch: 'feat/oauth2-login',
      bay: 'needs', stateKind: 'needs', waitingFor: 'input needed',
      now: 'Should sign-in support Google only, or Google and GitHub? GitHub needs a second set of client credentials in staging.',
      lastPrompt: 'Start with the login flow and keep the existing session cookies working.',
      goal: 'Replace our homegrown password login with OAuth2 sign-in without logging out existing users.',
      todos: [
        { text: 'Add OAuth2 provider config and the callback route', done: true },
        { text: 'Map provider accounts to existing user records', done: true },
        { text: 'Keep existing session cookies valid during the rollout', done: false },
        { text: 'Decide which providers to launch with', done: false },
        { text: 'Remove the old password form', done: false },
      ],
      todoSource: 'session',
      progress: 'The callback route and account mapping work against the staging provider. Waiting on which sign-in providers to launch with; the cookie migration comes next.',
      progressAt: ago(6),
      worktrees: [worktree('oauth2-login', ago(8))],
      stateSince: ago(7), updatedAt: ago(7), startedAt: ago(95),
      segments: [
        { from: ago(95), to: ago(80), state: 'working' },
        { from: ago(70), to: ago(48), state: 'working' },
        { from: ago(40), to: ago(7), state: 'working' },
        { from: ago(7), to: now, state: 'needs' },
      ],
      events: [
        { at: ago(7), actor: 'agent', state: null, text: 'Should sign-in support Google only, or Google and GitHub? GitHub needs a second set of client credentials in staging.' },
        { at: ago(9), actor: 'agent', state: null, text: 'Account mapping is done: existing users are matched by verified email, new users get a fresh record.' },
        { at: ago(41), actor: 'you', state: null, text: 'Looks good, keep going. Use the staging provider for now.' },
      ],
      subagents: [], jobs: [], pages: [], pr: null, contextTokens: 88_000,
    },
    {
      sessionId: SESSION_IDS.e2e, shortId: 'de100002', kind: 'interactive', entrypoint: 'claude-vscode',
      name: 'Fix flaky checkout e2e test', project: PROJECT, cwd: CWD, branch: 'fix/flaky-checkout-e2e',
      bay: 'working', stateKind: 'working',
      now: 'Running the checkout spec 50 times to confirm the flake is gone',
      lastPrompt: 'The checkout spec fails about once a day in CI. Find out why and fix it.',
      goal: 'The checkout spec fails about once a day in CI. Find out why and fix it.',
      todos: [
        { text: 'Reproduce the flaky failure locally', done: true },
        { text: 'Find what the test races against', done: true },
        { text: 'Fix the wait in the payment step', done: false },
        { text: 'Run the spec 50 times without a failure', done: false },
      ],
      todoSource: 'session',
      progress: 'The failure reproduces about once in 12 runs: the payment iframe is not ready when the test clicks Pay. Switched to an explicit wait and started a 50-run check.',
      progressAt: ago(3),
      worktrees: [worktree('fix-flaky-checkout', ago(2))],
      stateSince: ago(30), updatedAt: now - 6_000, startedAt: ago(42),
      segments: [
        { from: ago(42), to: ago(33), state: 'working' },
        { from: ago(30), to: now, state: 'working' },
      ],
      events: [
        { at: ago(2), actor: 'agent', state: null, text: 'Started the 50-run loop in the background.' },
        { at: ago(4), actor: 'agent', state: null, text: 'Replaced the fixed 500 ms sleep with a wait for the payment iframe to finish loading.' },
        { at: ago(15), actor: 'agent', state: null, text: 'Reproduced it: 1 failure in 12 runs, always on the Pay click.' },
        { at: ago(42), actor: 'you', state: null, text: 'The checkout spec fails about once a day in CI. Find out why and fix it.' },
      ],
      subagents: [],
      jobs: [
        {
          id: 'bj-1a2b', name: 'Run checkout spec 50 times', description: 'Run the checkout e2e spec 50 times to check the flake is gone',
          command: 'npx playwright test checkout.spec.ts --repeat-each=50 --reporter=line', status: 'running',
          startedAt: e2eStartedAt, endedAt: null, tail: `[${specRun}/50] checkout.spec.ts › pays with a saved card`,
        },
        {
          id: 'bj-0f9e', name: 'Capture a trace of the failing run', description: 'Run the checkout spec with tracing on until it fails once',
          command: 'npx playwright test checkout.spec.ts --trace on --repeat-each=20', status: 'completed',
          startedAt: ago(30), endedAt: ago(22), tail: null,
        },
      ],
      pages: [{ url: 'http://localhost:3910/checkout', label: 'localhost:3910/checkout', lastAt: ago(16), live: true }],
      pr: pullRequest(482, 'OPEN', null, 'pending'), contextTokens: 120_000,
    },
    {
      sessionId: SESSION_IDS.node, shortId: 'de100003', kind: 'interactive', entrypoint: 'cli',
      name: 'Upgrade services to Node 22', project: PROJECT, cwd: CWD, branch: 'chore/node-22',
      bay: 'working', stateKind: 'working',
      now: 'Waiting for the orders and inventory upgrades to report back',
      lastPrompt: 'Upgrade every service to Node 22. Do the services in parallel and keep CI green.',
      goal: 'Upgrade every service to Node 22. Do the services in parallel and keep CI green.',
      todos: [
        { text: 'List every service still pinned to Node 18 or 20', done: true },
        { text: 'Upgrade the base Docker image', done: true },
        { text: 'Upgrade each service and fix what breaks', done: false },
        { text: 'Get CI green on all services', done: false },
        { text: 'Update the deployment docs', done: false },
      ],
      todoSource: 'haiku',
      progress: 'Seven services were still on older Node versions. The base image is on Node 22; two services are being upgraded in parallel and one test suite needed a mock fix.',
      progressAt: ago(5),
      worktrees: [worktree('node22-orders', ago(1)), worktree('node22-inventory', ago(3))],
      stateSince: ago(55), updatedAt: now - 3_000, startedAt: ago(118),
      segments: [
        { from: ago(118), to: ago(96), state: 'working' },
        { from: ago(88), to: ago(61), state: 'working' },
        { from: ago(55), to: now, state: 'working' },
      ],
      events: [
        { at: ago(1), actor: 'agent', state: null, text: 'Orders: the upgrade builds, 3 tests still fail on the date mock.' },
        { at: ago(5), actor: 'agent', state: null, text: 'Started one agent per service so the upgrades run in parallel.' },
        { at: ago(60), actor: 'you', state: null, text: 'Do the services in parallel and keep CI green.' },
      ],
      subagents: [
        { id: 'sa-orders', agentType: 'general-purpose', description: 'Upgrade the orders service and fix failing tests', running: true },
        { id: 'sa-inventory', agentType: 'general-purpose', description: 'Upgrade the inventory service', running: true },
        { id: 'sa-scan', agentType: 'Explore', description: 'List services still pinned to Node 18 in Dockerfiles', running: false },
      ],
      jobs: [
        {
          id: 'bj-5d21', name: 'Build all service images', description: 'Build the Docker images for every service on the new base image',
          command: 'docker compose build --parallel', status: 'completed', startedAt: ago(38), endedAt: ago(31), tail: null,
        },
      ],
      pages: [], pr: null, contextTokens: 320_000,
    },
    {
      sessionId: SESSION_IDS.orders, shortId: 'de100004', kind: 'interactive', entrypoint: 'cli',
      name: 'Refactor order service', project: PROJECT, cwd: CWD, branch: 'refactor/order-service',
      bay: 'needs', stateKind: 'idle',
      now: 'Refactor is done and the unit tests pass. The load test failed: p95 latency on order creation went from 180 ms to 410 ms.',
      lastPrompt: 'Split the order service into smaller modules, then load-test it before we merge.',
      goal: 'Split the order service into smaller modules, then load-test it before we merge.',
      todos: [
        { text: 'Split pricing and inventory out of the order service', done: true },
        { text: 'Keep the public API unchanged', done: true },
        { text: 'Get the unit tests green', done: true },
        { text: 'Confirm the load test stays within the latency budget', done: false },
      ],
      todoSource: 'session',
      progress: 'The split is finished and the unit tests pass. The 10-minute load test failed: order creation is more than twice as slow, probably from the extra pricing lookup per line item.',
      progressAt: ago(44),
      worktrees: [worktree('refactor-orders', ago(46))],
      stateSince: null, updatedAt: ago(46), startedAt: ago(160),
      segments: [
        { from: ago(160), to: ago(131), state: 'working' },
        { from: ago(120), to: ago(92), state: 'working' },
        { from: ago(80), to: ago(46), state: 'working' },
      ],
      events: [
        { at: ago(46), actor: 'agent', state: null, text: 'Refactor is done and the unit tests pass. Started the load test in the background.' },
        { at: ago(82), actor: 'you', state: null, text: 'Looks good. Load-test it before we merge.' },
      ],
      subagents: [],
      jobs: [
        {
          id: 'bj-77c1', name: 'Load test order creation', description: 'Run the order-creation load test at 200 virtual users for 10 minutes',
          command: 'k6 run load/order-create.js --vus 200 --duration 10m', status: 'failed', startedAt: ago(52), endedAt: ago(41), tail: null,
        },
      ],
      pages: [], pr: pullRequest(473, 'OPEN', 'REVIEW_REQUIRED', 'fail'), contextTokens: 430_000,
    },
    {
      sessionId: SESSION_IDS.webhooks, shortId: 'de100005', kind: 'interactive', entrypoint: 'claude-vscode',
      name: 'Add retries to payment webhooks', project: PROJECT, cwd: CWD, branch: 'feat/webhook-retries',
      bay: 'done', stateKind: 'idle',
      now: 'Webhook retries are in, with exponential backoff and a dead-letter queue. All 34 tests pass and the PR is ready for review.',
      lastPrompt: 'Retry failed payment webhooks with backoff, and park the ones that never succeed.',
      goal: 'Retry failed payment webhooks with backoff, and park the ones that never succeed.',
      todos: [
        { text: 'Retry failed deliveries with exponential backoff', done: true },
        { text: 'Move deliveries that keep failing to a dead-letter queue', done: true },
        { text: 'Add tests for the retry schedule', done: true },
        { text: 'Open a PR', done: true },
      ],
      todoSource: 'haiku',
      progress: 'Retries use exponential backoff for up to 6 hours, then the delivery moves to a dead-letter queue. 34 tests pass and the PR is open.',
      progressAt: ago(22),
      worktrees: [worktree('webhook-retries', ago(30))],
      stateSince: null, updatedAt: ago(22), startedAt: ago(80),
      segments: [
        { from: ago(75), to: ago(60), state: 'working' },
        { from: ago(55), to: ago(22), state: 'working' },
      ],
      events: [
        { at: ago(22), actor: 'agent', state: null, text: 'Webhook retries are in, with exponential backoff and a dead-letter queue. All 34 tests pass and the PR is ready for review.' },
        { at: ago(56), actor: 'you', state: null, text: 'Cap the retries at 6 hours, then park the delivery.' },
      ],
      subagents: [], jobs: [], pages: [], pr: pullRequest(479, 'OPEN', 'APPROVED', 'pass'), contextTokens: 204_000,
    },
    {
      sessionId: SESSION_IDS.docs, shortId: 'de100006', kind: 'interactive', entrypoint: 'claude-desktop',
      name: 'Write v2 API docs', project: PROJECT, cwd: CWD, branch: 'docs/api-v2',
      bay: 'idle', stateKind: 'idle',
      now: 'Published the v2 reference for orders, customers and webhooks. Open questions are listed in docs/TODO.md.',
      lastPrompt: 'Write the reference for the v2 API: orders, customers and webhooks, with a curl example for each endpoint.',
      goal: 'Write the reference for the v2 API: orders, customers and webhooks, with a curl example for each endpoint.',
      todos: [
        { text: 'Document the orders endpoints', done: true },
        { text: 'Document customers and webhooks', done: true },
        { text: 'Add a curl example for every endpoint', done: true },
        { text: 'Merge the docs PR', done: true },
      ],
      todoSource: 'session',
      progress: 'All three resource groups are documented with a curl example per endpoint, and the PR is merged.',
      progressAt: ago(305),
      worktrees: [],
      stateSince: null, updatedAt: ago(300), startedAt: ago(420),
      segments: [], events: [
        { at: ago(300), actor: 'agent', state: null, text: 'Published the v2 reference for orders, customers and webhooks. Open questions are listed in docs/TODO.md.' },
        { at: ago(330), actor: 'you', state: null, text: 'Add a curl example for each endpoint.' },
      ],
      subagents: [], jobs: [], pages: [], pr: pullRequest(461, 'MERGED', 'APPROVED', 'pass'), contextTokens: 61_000,
    },
    {
      sessionId: SESSION_IDS.audit, shortId: 'de100007', kind: 'background', entrypoint: null,
      name: 'Nightly dependency audit', project: PROJECT, cwd: CWD, branch: 'chore/dependency-audit',
      bay: 'working', stateKind: 'working',
      now: `Checking packages against the advisory database (${Math.min(212, 120 + Math.floor((now - ago(35)) / 15_000))} of 212 done)`,
      lastPrompt: null,
      goal: 'Audit all dependencies for known vulnerabilities and open a PR with the safe upgrades.',
      todos: [
        { text: 'Scan every dependency against the advisory database', done: false },
        { text: 'Pick the upgrades that do not change behavior', done: false },
        { text: 'Open a PR with the safe upgrades', done: false },
      ],
      todoSource: 'haiku',
      progress: 'The scan found 3 vulnerable packages so far, all with a patch release available.',
      progressAt: ago(4),
      worktrees: [],
      stateSince: ago(35), updatedAt: now - 4_000, startedAt: ago(35),
      segments: [{ from: ago(35), to: now, state: 'working' }],
      events: [
        { at: ago(4), actor: 'agent', state: 'working', text: 'Scanning dependencies' },
        { at: ago(35), actor: 'agent', state: 'working', text: 'Started the audit' },
      ],
      subagents: [], jobs: [], pages: [], pr: null, contextTokens: 146_000,
    },
    {
      sessionId: SESSION_IDS.backfill, shortId: 'de100008', kind: 'background', entrypoint: null,
      name: 'Backfill order history', project: PROJECT, cwd: CWD, branch: 'chore/backfill-orders',
      bay: 'needs', stateKind: 'failed',
      now: 'Stopped at row 48,213: the legacy orders table has a NULL currency on 3 rows',
      lastPrompt: null,
      goal: 'Copy the legacy order history into the new orders table, converting amounts to cents.',
      todos: [
        { text: 'Copy orders from the legacy table in batches', done: true },
        { text: 'Convert amounts to cents', done: false },
        { text: 'Check row counts against the legacy table', done: false },
      ],
      todoSource: 'haiku',
      progress: 'The backfill copied 48,000 orders and then stopped on 3 legacy rows that have no currency. It needs a rule for them before it can continue.',
      progressAt: ago(25),
      worktrees: [],
      stateSince: ago(26), updatedAt: ago(26), startedAt: ago(64),
      segments: [
        { from: ago(64), to: ago(26), state: 'working' },
        { from: ago(26), to: now, state: 'failed' },
      ],
      events: [
        { at: ago(26), actor: 'agent', state: 'failed', text: 'Stopped at row 48,213: NULL currency' },
        { at: ago(64), actor: 'agent', state: 'working', text: 'Started the backfill' },
      ],
      subagents: [], jobs: [], pages: [], pr: null, contextTokens: null,
    },
  ]
}
