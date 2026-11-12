// The middle block of the readings band: CPU, memory, swap and disk of the machine the dashboard runs on.
// Color only says "take a look", as everywhere else on the board: CPU by how busy it is, memory by the system's own
// memory pressure where there is one (a Mac fills its memory with cache on purpose, so a high share alone means
// little), swap by its size against memory, the disk by how little space is left.
import type { MachineReading } from '../../shared/types.ts'
import { formatBytes } from './format.ts'
import { useI18n } from './i18n.tsx'
import { Meter } from './SessionCard.tsx'
import { type Level, level } from './Usage.tsx'

const PRESSURE_LEVEL = { normal: 'ok', warn: 'warn', critical: 'high' } as const satisfies Record<string, Level>

/** Without a pressure reading: only a nearly full memory is worth a look */
function memoryLevel(percent: number): Level {
  if (percent >= 95) return 'high'
  if (percent >= 85) return 'warn'
  return 'ok'
}

/** Swap by what it amounts to against memory: a quarter of it already slows switching down noticeably */
function swapLevel(share: number): Level {
  if (share >= 0.5) return 'high'
  if (share >= 0.25) return 'warn'
  return 'ok'
}

/** By the share left: a big disk with 10% free still has room, but the next checkpoints may not fit */
function diskLevel(freeShare: number): Level {
  if (freeShare < 0.05) return 'high'
  if (freeShare < 0.1) return 'warn'
  return 'ok'
}

/** Number and unit apart, the unit a size smaller: "12.3 GB" → ["12.3", " GB"] */
function split(text: string): [string, string] {
  const at = text.lastIndexOf(' ')
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at)]
}

function Reading({ label, labelLevel, value, unit, fraction, barLevel, title }: {
  label: string; labelLevel?: Level; value: string; unit: string; fraction: number | null; barLevel: Level; title: string
}) {
  return (
    <div className="reading" title={title}>
      <span className="reading-label" data-level={labelLevel === 'ok' ? undefined : labelLevel}>{label}</span>
      <b>{value}<small>{unit}</small></b>
      {fraction !== null && <Meter fraction={fraction} level={barLevel} />}
    </div>
  )
}

export function Machine({ machine }: { machine: MachineReading }) {
  const { t } = useI18n()
  const { memory, disk } = machine
  const memoryPercent = memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null
  const memoryLvl = memory.pressure !== null ? PRESSURE_LEVEL[memory.pressure] : memoryPercent === null ? 'ok' : memoryLevel(memoryPercent)
  const used = formatBytes(memory.usedBytes, 1024)
  const total = formatBytes(memory.totalBytes, 1024)
  const swap = memory.swapUsedBytes === null ? null : formatBytes(memory.swapUsedBytes, 1024)
  const swapShare = memory.swapUsedBytes !== null && memory.totalBytes > 0 ? memory.swapUsedBytes / memory.totalBytes : null
  const free = disk === null ? null : formatBytes(disk.freeBytes, 1000)
  return (
    <section className="panel" aria-label={t('machine.label')}>
      <h2 className="panel-title">{t('machine.label')}<span>{t('machine.spec', { n: machine.cores, total })}</span></h2>
      <div className="readings">
        <Reading label={t('machine.cpu')} value={machine.cpuPercent === null ? '—' : `${Math.round(machine.cpuPercent)}`} unit={machine.cpuPercent === null ? '' : '%'}
          fraction={machine.cpuPercent === null ? null : machine.cpuPercent / 100} barLevel={machine.cpuPercent === null ? 'ok' : level(machine.cpuPercent)}
          title={t('machine.hint.cpu')} />
        <Reading label={t(memory.pressure === null ? 'machine.memory.used' : `machine.memory.${memory.pressure}`)} labelLevel={memoryLvl}
          value={split(used)[0]} unit={` / ${total}`}
          fraction={memoryPercent === null ? null : memoryPercent / 100} barLevel={memoryLvl}
          title={t('machine.hint.memory', { used, total })} />
        {swap !== null && swapShare !== null && (
          <Reading label={t('machine.swap')} value={split(swap)[0]} unit={split(swap)[1]}
            fraction={swapShare} barLevel={swapLevel(swapShare)} title={t('machine.hint.swap', { size: swap })} />
        )}
        {disk !== null && free !== null && disk.totalBytes > 0 && (
          <Reading label={t('machine.diskFree')} value={split(free)[0]} unit={split(free)[1]}
            fraction={(disk.totalBytes - disk.freeBytes) / disk.totalBytes} barLevel={diskLevel(disk.freeBytes / disk.totalBytes)}
            title={t('machine.hint.disk', { free, total: formatBytes(disk.totalBytes, 1000) })} />
        )}
      </div>
    </section>
  )
}
