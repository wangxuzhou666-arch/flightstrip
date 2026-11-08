// Retired sessions: folded at the very bottom of the overview
import { useState } from 'react'
import type { RetiredRow } from '../../shared/types.ts'
import { postAction } from './api.ts'
import { useI18n } from './i18n.tsx'
import { StageMark } from './SessionCard.tsx'

export function RetiredFold({ rows, now }: { rows: RetiredRow[]; now: number }) {
  const { t, fmt } = useI18n()
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const restore = (sessionId: string) => {
    setFailure(null)
    postAction(sessionId, 'unretire').catch((err: Error) => setFailure(err.message))
  }
  return (
    <section className="section">
      <button type="button" className="text-btn retired-toggle" aria-expanded={open} aria-controls="retired-list" onClick={() => setOpen(!open)}>
        {open ? t('retired.hide', { n: rows.length }) : t('retired.show', { n: rows.length })}
      </button>
      {open && (
        <ul id="retired-list" className="rows">
          {rows.map((row) => (
            <li key={row.sessionId} className="row">
              <span className="row-stage"><StageMark stage={{ tone: 'idle', label: t('retired.label'), sub: fmt.ago(row.retiredAt, now) }} /></span>
              <span className="row-body">
                <span className="row-title">{row.name}</span>
                <span className="row-meta">{row.kind === 'background' ? t('retired.background') : t('retired.interactive')}</span>
              </span>
              <span className="row-side"><button type="button" className="btn btn--outline" onClick={() => restore(row.sessionId)}>{t('retired.restore')}</button></span>
            </li>
          ))}
        </ul>
      )}
      {failure !== null && <p className="error" role="alert">{failure}</p>}
    </section>
  )
}
