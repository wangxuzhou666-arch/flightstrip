// Drag a group header to reorder groups: press and hold the handle left of the header and drag up or down, release to
// save; with the handle focused, ↑ ↓ move it one step at a time.
// When a drag starts all groups first collapse into one-line headers (a group thousands of pixels tall can't be
// dragged); both the collapse and the expand after release compensate the scroll position so the dragged header stays
// under the hand.
// During the drag the DOM order doesn't change: transform alone makes the dragged group follow the pointer and shifts
// displaced groups by one step; the order really changes on release.
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react'

const START_DISTANCE = 4 // moving more than this many pixels after pressing starts a drag: merely clicking the handle shouldn't collapse every group

interface Drag {
  id: string
  from: number
  to: number
  dy: number
  step: number // how far a displaced group shifts = dragged group height + gap; 0 until measured after collapsing
}

interface Press {
  id: string
  startY: number
  grabOffset: number // distance from the pointer to the group's top, constant during the drag
}

interface Slot {
  top: number // document coordinates, no re-measuring needed when the page scrolls
  height: number
}

export interface GripHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: () => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

export function useGroupDrag(order: string[], onMove: (id: string, to: number) => void) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const press = useRef<Press | null>(null)
  const slots = useRef<Slot[]>([])
  // After the next render, which group's top goes back to which viewport position (collapsing / expanding makes it jump)
  const anchor = useRef<{ id: string; top: number } | null>(null)
  const refocus = useRef<string | null>(null)

  const sectionOf = (id: string) => containerRef.current?.querySelector<HTMLElement>(`[data-group="${id}"]`) ?? null

  useLayoutEffect(() => {
    if (anchor.current !== null) {
      const { id, top } = anchor.current
      anchor.current = null
      const el = sectionOf(id)
      if (el !== null) window.scrollBy(0, el.getBoundingClientRect().top - top)
    }
    if (drag !== null && drag.step === 0) {
      // Positions after collapsing: every later move is computed from these, no more DOM measuring
      slots.current = order.map((id) => {
        const rect = sectionOf(id)?.getBoundingClientRect()
        return rect === undefined ? { top: 0, height: 0 } : { top: rect.top + window.scrollY, height: rect.height }
      })
      const gap = containerRef.current === null ? 0 : parseFloat(getComputedStyle(containerRef.current).rowGap) || 0
      setDrag({ ...drag, step: slots.current[drag.from].height + gap })
    }
    if (refocus.current !== null) {
      containerRef.current?.querySelector<HTMLElement>(`[data-grip="${refocus.current}"]`)?.focus()
      refocus.current = null
    }
  })

  const finish = (commit: boolean) => {
    press.current = null
    if (drag === null) return
    const el = sectionOf(drag.id)
    if (el !== null) anchor.current = { id: drag.id, top: el.getBoundingClientRect().top }
    setDrag(null)
    if (commit && drag.to !== drag.from) onMove(drag.id, drag.to)
  }

  const grip = (id: string): GripHandlers => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return
      const el = sectionOf(id)
      if (el === null) return
      e.preventDefault() // keep the drag from selecting text
      e.currentTarget.setPointerCapture(e.pointerId)
      press.current = { id, startY: e.clientY, grabOffset: e.clientY - el.getBoundingClientRect().top }
    },
    onPointerMove: (e) => {
      const p = press.current
      if (p === null || p.id !== id) return
      if (drag === null) {
        if (Math.abs(e.clientY - p.startY) < START_DISTANCE) return
        anchor.current = { id, top: e.clientY - p.grabOffset }
        const from = order.indexOf(id)
        setDrag({ id, from, to: from, dy: 0, step: 0 })
        return
      }
      if (drag.step === 0) return
      const own = slots.current[drag.from]
      const dy = e.clientY + window.scrollY - p.grabOffset - own.top
      const center = own.top + dy + own.height / 2
      const to = slots.current.filter((slot, i) => i !== drag.from && slot.top + slot.height / 2 < center).length
      setDrag({ ...drag, dy, to })
    },
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
    onKeyDown: (e) => {
      const from = order.indexOf(id)
      const to = e.key === 'ArrowUp' ? from - 1 : e.key === 'ArrowDown' ? from + 1 : from
      if (to === from) return
      e.preventDefault() // arrow keys no longer scroll the page
      if (to < 0 || to >= order.length) return
      refocus.current = id
      onMove(id, to)
    },
  })

  /** Where each group shifts to during a drag: the dragged one follows the pointer, ones between start and drop make room by one step */
  const offsetOf = (id: string): number => {
    if (drag === null) return 0
    if (id === drag.id) return drag.dy
    const i = order.indexOf(id)
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -drag.step
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.step
    return 0
  }

  return { containerRef, dragging: drag?.id ?? null, grip, offsetOf }
}
