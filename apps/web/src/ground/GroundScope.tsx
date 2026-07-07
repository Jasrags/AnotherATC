import { useEffect, useRef } from 'react'
import { KSAN_SURFACE } from '@anotheratc/sim'
import type { GroundController } from './controller'
import { fitView, pan, reframe, toWorld, zoomAt, type View } from './view'
import {
  drawAircraft,
  drawAreaLabels,
  drawGates,
  drawHotspots,
  drawLabels,
  drawRouteDraft,
  drawRouteHover,
  drawSelection,
  drawSurface,
  nearestTaxiwayRef,
} from './render'
import { isTypingTarget } from './keyboard'

/** Fixed simulation timestep (seconds) — decoupled from the render framerate. */
const FIXED_DT = 0.05
/** Click must land within this many px of a target to select it. */
const HIT_PX = 14
/** Click within this many px of a taxiway snaps to it (generous — the hover preview
 *  shows exactly which taxiway will be picked, so a wide radius is safe). */
const TAXI_HIT_PX = 26
/** Pointer movement beyond this (px) counts as a pan, not a click. */
const DRAG_PX = 4

/** Set an element's text only when it changed — avoids re-announcing aria-live regions. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

export function GroundScope({ controller }: { controller: GroundController }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const sim = controller.sim

    let width = 0
    let height = 0
    let dpr = 1
    let view: View | null = null

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const newW = rect.width
      const newH = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(newW * dpr)
      canvas.height = Math.round(newH * dpr)
      // First layout fits to bounds; later resizes/reflows preserve the controller's
      // pan/zoom by holding the world point at screen center (WEB-2).
      view = view ? reframe(view, width, height, newW, newH) : fitView(KSAN_SURFACE.bounds, newW, newH)
      width = newW
      height = newH
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // Active pointers (mouse or touch). One → pan/tap; two → pinch-zoom.
    const pointers = new Map<number, { x: number; y: number }>()
    let moved = false
    let downX = 0
    let downY = 0
    let pinchDist = 0
    let pinchCx = 0
    let pinchCy = 0
    // Mouse hover, for the route-mode preview of the taxiway a click would pick.
    let hoverX = -1
    let hoverY = -1
    let hovering = false

    const rectPt = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pinchState = (): { dist: number; cx: number; cy: number } => {
      const [a, b] = [...pointers.values()]
      if (!a || !b) return { dist: 0, cx: 0, cy: 0 }
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!view) return
      const rect = canvas.getBoundingClientRect()
      view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const p = rectPt(e)
      pointers.set(e.pointerId, p)
      canvas.setPointerCapture(e.pointerId)
      if (pointers.size === 1) {
        moved = false
        downX = p.x
        downY = p.y
      } else if (pointers.size === 2) {
        const s = pinchState()
        pinchDist = s.dist
        pinchCx = s.cx
        pinchCy = s.cy
        moved = true
      }
    }
    const onMove = (e: PointerEvent) => {
      const p = rectPt(e)
      if (e.pointerType === 'mouse') {
        hoverX = p.x
        hoverY = p.y
        hovering = true
      }
      const prev = pointers.get(e.pointerId)
      if (!prev || !view) return
      pointers.set(e.pointerId, p)
      if (pointers.size >= 2) {
        const s = pinchState()
        if (pinchDist > 0) {
          view = zoomAt(view, s.dist / pinchDist, s.cx, s.cy)
          view = pan(view, s.cx - pinchCx, s.cy - pinchCy)
        }
        pinchDist = s.dist
        pinchCx = s.cx
        pinchCy = s.cy
        moved = true
      } else {
        if (Math.hypot(p.x - downX, p.y - downY) > DRAG_PX) moved = true
        view = pan(view, p.x - prev.x, p.y - prev.y)
      }
    }
    const endPointer = (e: PointerEvent) => {
      const had = pointers.delete(e.pointerId)
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      if (pointers.size < 2) pinchDist = 0
      if (had && pointers.size === 0 && !moved && view) handleClick(downX, downY)
    }
    const onLeave = () => {
      hovering = false
    }
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const id = controller.selectedId()
      if (id) controller.dispatch({ type: 'hold', aircraftId: id })
    }
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return // don't hijack keys meant for a focused text field
      const id = controller.selectedId()
      const draft = controller.routeDraft()
      if (e.key === 'Escape') {
        if (draft) controller.clearRoute()
        else controller.select(null)
      } else if (e.key === 'Backspace' && draft) {
        e.preventDefault()
        controller.removeViaAt(draft.via.length - 1) // drop the last taxiway
      } else if ((e.key === 'c' || e.key === 'C') && id) {
        controller.dispatch({ type: 'crossRunway', aircraftId: id })
      }
    }

    const toScreenSafe = (x: number, y: number): [number, number] => {
      if (!view) return [-1e6, -1e6]
      return [x * view.scale + view.offX, -y * view.scale + view.offY]
    }

    function handleClick(sx: number, sy: number): void {
      if (!view) return
      const snap = sim.snapshot()
      let hit: string | null = null
      let hitDist = HIT_PX
      for (const a of snap.aircraft) {
        const [ax, ay] = toScreenSafe(a.x, a.y)
        const d = Math.hypot(ax - sx, ay - sy)
        if (d < hitDist) {
          hitDist = d
          hit = a.id
        }
      }
      const selectedId = controller.selectedId()
      const draft = controller.routeDraft()
      if (hit) {
        controller.select(hit)
      } else if (draft) {
        // Route-building mode: a click on a taxiway appends it to the via-sequence.
        const [wx, wy] = toWorld(view, sx, sy)
        const ref = nearestTaxiwayRef(KSAN_SURFACE, wx, wy, TAXI_HIT_PX / view.scale)
        if (ref) controller.addVia(ref)
      } else if (selectedId) {
        const [wx, wy] = toWorld(view, sx, sy)
        controller.dispatch({ type: 'taxiTo', aircraftId: selectedId, dest: [wx, wy] })
      } else {
        controller.select(null)
      }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('keydown', onKey)

    let raf = 0
    let last = 0
    let started = false
    let acc = 0

    const frame = (t: number) => {
      if (!started) {
        last = t
        started = true
      }
      let dt = (t - last) / 1000
      last = t
      if (dt > 0.25) dt = 0.25
      acc += dt
      let steps = 0
      while (acc >= FIXED_DT && steps < 30) {
        sim.step(FIXED_DT)
        acc -= FIXED_DT
        steps += 1
      }
      controller.publish()

      if (view) {
        ctx.save()
        ctx.scale(dpr, dpr)
        const snap = sim.snapshot()
        const selectedId = controller.selectedId()
        const draft = controller.routeDraft()
        drawSurface(ctx, view, KSAN_SURFACE, width, height)
        drawAreaLabels(ctx, view, KSAN_SURFACE)
        drawGates(ctx, view, KSAN_SURFACE)
        drawHotspots(ctx, view, KSAN_SURFACE)
        if (draft) {
          drawRouteDraft(ctx, view, KSAN_SURFACE, draft.via)
          if (hovering) {
            const [wx, wy] = toWorld(view, hoverX, hoverY)
            const ref = nearestTaxiwayRef(KSAN_SURFACE, wx, wy, TAXI_HIT_PX / view.scale)
            if (ref && !draft.via.includes(ref)) drawRouteHover(ctx, view, KSAN_SURFACE, ref)
          }
        }
        drawLabels(ctx, view, KSAN_SURFACE)
        drawAircraft(ctx, view, snap.aircraft)
        const selected = selectedId ? snap.aircraft.find((a) => a.id === selectedId) : undefined
        drawSelection(ctx, view, selected, selectedId ? sim.routeOf(selectedId) : [])
        ctx.restore()

        // Only write when the text actually changes: the status/hint/alert nodes are
        // aria-live regions, and re-assigning an identical string re-announces it.
        if (statusRef.current) {
          const moving = snap.aircraft.filter((a) => a.groundspeed > 0).length
          const mm = String(Math.floor(snap.time / 60)).padStart(2, '0')
          const ss = String(Math.floor(snap.time % 60)).padStart(2, '0')
          setText(statusRef.current, `${moving} taxiing · ${snap.aircraft.length} on surface · dep ${snap.departed} · arr ${snap.arrived} · T+${mm}:${ss}`)
        }
        if (alertRef.current) {
          const inConflict = snap.aircraft.filter((a) => a.conflict).length
          setText(alertRef.current, inConflict > 0 ? `⚠ CONFLICT` : '')
        }
        if (hintRef.current) {
          const notice = controller.notice()
          let hint: string
          if (notice) {
            hint = `⛔ ${notice}`
          } else if (draft && selected) {
            const via = draft.via.length ? `via ${draft.via.join(' · ')}` : '(none yet)'
            hint = `Routing ${selected.callsign} ${via} — click taxiways to add · tap a chip or Backspace to remove · pick a destination to issue · Esc to cancel`
          } else if (selected?.holdShort) {
            hint =
              selected.intent === 'departure'
                ? `${selected.callsign} holding short — use the strip's Contact tower (or C) to release for departure · Esc to deselect`
                : `${selected.callsign} holding short of the runway — press C to clear across · Esc to deselect`
          } else if (selected) {
            hint = `${selected.callsign} selected — click a point to assign taxi · right-click to hold · Esc to deselect`
          } else {
            hint = 'click an aircraft (scope or strip) to select · drag to pan · scroll to zoom'
          }
          setText(hintRef.current, hint)
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', endPointer)
      canvas.removeEventListener('pointercancel', endPointer)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKey)
    }
  }, [controller])

  return (
    <div className="scope">
      <canvas
        ref={canvasRef}
        className="scope-canvas"
        tabIndex={0}
        role="application"
        aria-label="KSAN ground surface radar. Tab to a flight strip to select and command an aircraft; drag to pan, scroll to zoom."
      />
      <div className="hud hud-tl">
        <div className="hud-title">KSAN · SAN DIEGO INTL</div>
        <div className="hud-sub">GND CON 123.9 · D-ATIS 134.8 · SURFACE (ASDE-X)</div>
      </div>
      <div ref={statusRef} className="hud hud-tr mono" />
      <div ref={alertRef} className="hud hud-alert mono" role="alert" />
      <div ref={hintRef} className="hud hud-bc mono" aria-live="polite" />
    </div>
  )
}
