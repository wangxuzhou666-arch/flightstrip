// What a running background job's line adds to its name and start time: how far it has got (read from the progress
// marks in its output), a warning when it has printed nothing for a while, and what its processes use right now.
// Shared by the strips and the background jobs page.
import type { BackgroundJob, JobProgress } from '../../shared/types.ts'
import { formatBytes } from './format.ts'
import { useI18n } from './i18n.tsx'

// Running and silent this long is worth a note: long enough that a build step or a test file that only prints when it
// finishes doesn't set it off
export const STALL_MS = 5 * 60_000
// Below this (share of one core) a silent job is doing nothing, so the note turns amber; a silent job still using the
// CPU is most likely in a long step, so its note stays grey
const IDLE_CPU = 5

export function JobProgressRow({ progress }: { progress: JobProgress }) {
  const { t } = useI18n()
  const percent = Math.round(progress.fraction * 100)
  return (
    <span className="job-progress">
      <span className="job-track" role="progressbar" aria-label={t('jobline.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="job-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="job-mark">{progress.mark}</span>
      {progress.label !== null && <span className="job-step" title={progress.label}>{progress.label}</span>}
    </span>
  )
}

/** The stall warning and the CPU and memory figures, on a line of their own; nothing for a job that ended */
export function JobSignals({ job, now }: { job: BackgroundJob; now: number }) {
  const { t, fmt } = useI18n()
  if (job.status !== 'running') return null
  const quietSince = job.lastOutputAt
  const stalled = quietSince !== null && now - quietSince >= STALL_MS
  if (!stalled && job.usage === null) return null
  // Without a CPU figure there is no telling, so it counts as idle
  const busy = job.usage !== null && job.usage.cpuPercent >= IDLE_CPU
  return (
    <span className="job-signals">
      {stalled && (
        <span className="job-stall" data-busy={busy || undefined}
          title={t(busy ? 'jobline.stalledBusy' : 'jobline.stalledIdle', { time: fmt.clock(quietSince) })}>
          {t('jobline.stalled', { span: fmt.span(quietSince, now) })}
        </span>
      )}
      {job.usage !== null && (
        <span className="job-usage" title={t('jobline.usageHint', { n: job.usage.processes })}>
          <span>{t('jobline.cpu', { percent: `${Math.round(job.usage.cpuPercent)}%` })}</span>
          <span>{t('jobline.memory', { size: formatBytes(job.usage.memoryBytes, 1024) })}</span>
        </span>
      )}
    </span>
  )
}

/** The last line of output, unless the progress row already shows it */
export function showsTail(job: BackgroundJob): boolean {
  return job.tail !== null && job.progress?.lineIsTail !== true
}
