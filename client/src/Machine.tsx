// Load of the machine the dashboard runs on, beside the subscription usage: CPU, memory and disk, in the same meters.
// Color only says "take a look", as everywhere else on the board: CPU by how busy it is, memory by the system's own
// memory pressure where there is one (a Mac fills its memory with cache on purpose, so a high share alone means
// little), the disk by how little space is left.
import type { MachineReading } from '../../shared/types.ts'
import { formatBytes } from './format.ts'
import { useI18n } from './i18n.tsx'
import { type Level, level, MeterRow } from './Usage.tsx'

const PRESSURE_TONE = { normal: 'ok', warn: 'warn', critical: 'high' } as const satisfies Record<string, Level>

/** Without a pressure reading: only a nearly full memory is worth a look */
function memoryTone(percent: number): Level {
  if (percent >= 95) return 'high'
  if (percent >= 85) return 'warn'
  return 'ok'
}

/** By the share left: a big disk with 10% free still has room, but the next checkpoints may not fit */
function diskTone(freeShare: number): Level {
  if (freeShare < 0.05) return 'high'
  if (freeShare < 0.1) return 'warn'
  return 'ok'
}

export function Machine({ machine }: { machine: MachineReading }) {
  const { t } = useI18n()
  const { memory, disk } = machine
  const memoryPercent = memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null
  const used = formatBytes(memory.usedBytes, 1024)
  const total = formatBytes(memory.totalBytes, 1024)
  const memoryNote = memory.pressure === 'warn' || memory.pressure === 'critical'
    ? t(`machine.pressure.${memory.pressure}`)
    : t('machine.memoryOf', { used, total })
  return (
    <div className="usage machine" aria-label={t('machine.label')}>
      <MeterRow label={t('machine.cpu')} percent={machine.cpuPercent} tone={machine.cpuPercent === null ? undefined : level(machine.cpuPercent)}
        note={t('machine.cores', { n: machine.cores })} title={t('machine.hint.cpu')} />
      <MeterRow label={t('machine.memory')} percent={memoryPercent}
        tone={memory.pressure !== null ? PRESSURE_TONE[memory.pressure] : memoryPercent === null ? undefined : memoryTone(memoryPercent)}
        note={memoryNote} title={t('machine.hint.memory', { used, total })} />
      {disk !== null && disk.totalBytes > 0 && (
        <MeterRow label={t('machine.disk')} percent={((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100}
          tone={diskTone(disk.freeBytes / disk.totalBytes)}
          note={t('machine.diskFree', { free: formatBytes(disk.freeBytes, 1000) })}
          title={t('machine.hint.disk', { free: formatBytes(disk.freeBytes, 1000), total: formatBytes(disk.totalBytes, 1000) })} />
      )}
    </div>
  )
}
