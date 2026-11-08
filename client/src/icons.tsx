// Line icons: the stroke color follows the text (.icon-btn svg path sets stroke uniformly)

export function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M3.5 16.5h3l9-9a2.1 2.1 0 0 0-3-3l-9 9v3z M11 6l3 3" />
    </svg>
  )
}

/** Storage box: retire = put away, not delete */
export function RetireIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M2.5 4h15v3.5h-15z M4 7.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8 M8 11h4" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.6 1.8h7.4a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      <path d="M3.5 5.5h13 M8 5.5V3.8h4v1.7 M5 5.5l.8 10.2a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9L15 5.5" />
    </svg>
  )
}

/** Drag handle: two columns of three small dots */
export function GripIcon() {
  return (
    <svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true">
      {[4, 8].flatMap((x) => [4, 8, 12].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.15" fill="currentColor" />))}
    </svg>
  )
}

export function CaretIcon() {
  return (
    <svg className="caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
