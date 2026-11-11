// Reading a background job's progress from its output, and the parsers behind the machine meters.
//   P (progress marks): step counters, percentages, tqdm bars and counted words give a bar with the step name; bare
//     fractions and percentages (frame rates, dates, load figures) and impossible counts give none; the newest mark wins.
//   R (resources): Activity Monitor's Memory Used from vm_stat, used memory from /proc/meminfo, CPU time from ps.
// The TypeScript is loaded through tsx, so this runs on every Node the package supports.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { progressIn } = await tsImport('../shared/jobProgress.ts', import.meta.url)
const { cpuSecondsOf, darwinMemoryUsed, linuxMemoryUsed } = await tsImport('../server/resources.ts', import.meta.url)

const one = (line) => progressIn([line])

test('P1 each kind of mark gives a fraction, the mark as printed and the step it names', () => {
  assert.deepEqual(one('==> [3/8] Sync code'), { fraction: 3 / 8, mark: '3/8', label: 'Sync code', lineIsTail: true })
  assert.deepEqual(one('tests/test_api.py ........ [ 45%]'), { fraction: 0.45, mark: '45%', label: 'tests/test_api.py ........', lineIsTail: true })
  assert.deepEqual(one('train:  45%|████▌     | 450/1000 [00:30<00:40, 15.00it/s]'), { fraction: 0.45, mark: '45%', label: 'train', lineIsTail: true })
  assert.deepEqual(one('Epoch 4/20 - loss: 0.31'), { fraction: 0.2, mark: 'Epoch 4/20', label: 'loss: 0.31', lineIsTail: true })
  assert.deepEqual(one('step 2 of 5: building'), { fraction: 0.4, mark: 'step 2/5', label: 'building', lineIsTail: true })
  assert.equal(one('[12/12]').label, null, 'a line that is only the mark has no step name')
})

test('P2 numbers that only look like progress give no bar', () => {
  for (const line of [
    'Stream #0: Video: h264, 30/1 fps',
    'Report for 11/08 is ready',
    'latency p50/p90: 12/40 ms',
    'disk 85% full',
    '[2026/11] archive rotated',
    '[0/0] nothing to do',
    '[ 150%]',
    'epoch 21/20',
  ]) {
    assert.equal(one(line), null, line)
  }
})

test('P3 the newest mark wins, and says whether it is on the last line', () => {
  const lines = ['[1/4] Install', 'added 120 packages', '[2/4] Build', 'compiled 31 files']
  assert.deepEqual(progressIn(lines), { fraction: 0.5, mark: '2/4', label: 'Build', lineIsTail: false })
  assert.equal(progressIn([...lines, '[3/4] Test']).lineIsTail, true)
  assert.equal(progressIn(['no marks here', 'still none']), null)
})

test('P4 a long step name is clipped', () => {
  const label = one(`[1/2] ${'x'.repeat(200)}`).label
  assert.equal(label.length, 81)
  assert.ok(label.endsWith('…'))
})

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    27503.
Pages active:                                 312049.
Pages inactive:                               261849.
Pages wired down:                             284314.
Pages purgeable:                                1696.
File-backed pages:                            154220.
Anonymous pages:                              469186.
Pages occupied by compressor:                  75946.
`

test('R1 memory used: Activity Monitor\'s sum on macOS, total minus available on Linux, null when a line is missing', () => {
  assert.equal(darwinMemoryUsed(VM_STAT), (469186 - 1696 + 284314 + 75946) * 16384)
  assert.equal(darwinMemoryUsed(VM_STAT.replace(/^Pages wired down.*$/m, '')), null)
  assert.equal(linuxMemoryUsed('MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    4096000 kB\n'), (16384000 - 4096000) * 1024)
  assert.equal(linuxMemoryUsed('MemTotal:       16384000 kB\n'), null)
})

test('R2 CPU time in the forms ps prints it on macOS and Linux', () => {
  assert.equal(cpuSecondsOf('0:03.46'), 3.46)
  assert.equal(cpuSecondsOf('1:02:03.50'), 3723.5)
  assert.equal(cpuSecondsOf('00:00:03'), 3)
  assert.equal(cpuSecondsOf('2-01:00:00'), 2 * 86_400 + 3600)
})
