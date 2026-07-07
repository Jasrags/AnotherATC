import { useEffect, useRef } from 'react'
import { KSAN_SURFACE } from '@anotheratc/sim'
import type { GroundController } from './controller'
import { fitView, pan, toWorld, zoomAt, type View } from './view'
import { drawAircraft, drawLabels, drawSelection, drawSurface } from './render'

/** Fixed simulation timestep (seconds) — decoupled from the render framerate. */
const FIXED_DT = 0.05
/** Click must land within this many px of a target to select it. */
const HIT_PX = 14
/** Pointer movement beyond this (px) counts as a pan, not a click. */
const DRAG_PX = 4

export function GroundScope({ controller }: { controller: GroundController }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)

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
      width = rect.width
      height = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      view = fitView(KSAN_SURFACE.bounds, width, height)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    let dragging = false
    let moved = false
    let lastX = 0
    let lastY = 0
    let downX = 0
    let downY = 0

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!view) return
      const rect = canvas.getBoundingClientRect()
      view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = true
      moved = false
      lastX = e.clientX
      lastY = e.clientY
      downX = e.clientX
      downY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging || !view) return
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) moved = true
      view = pan(view, e.clientX - lastX, e.clientY - lastY)
      lastX = e.clientX
      lastY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = false
      canvas.releasePointerCapture(e.pointerId)
      if (moved || !view) return
      const rect = canvas.getBoundingClientRect()
      handleClick(e.clientX - rect.left, e.clientY - rect.top)
    }
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const id = controller.selectedId()
      if (id) controller.dispatch({ type: 'hold', aircraftId: id })
    }
    const onKey = (e: KeyboardEvent) => {
      const id = controller.selectedId()
      if (e.key === 'Escape') controller.select(null)
      else if ((e.key === 'c' || e.key === 'C') && id) {
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
      if (hit) {
        controller.select(hit)
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
    canvas.addEventListener('pointerup', onUp)
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
        drawSurface(ctx, view, KSAN_SURFACE, width, height)
        drawLabels(ctx, view, KSAN_SURFACE)
        drawAircraft(ctx, view, snap.aircraft)
        const selected = selectedId ? snap.aircraft.find((a) => a.id === selectedId) : undefined
        drawSelection(ctx, view, selected, selectedId ? sim.routeOf(selectedId) : [])
        ctx.restore()

        if (statusRef.current) {
          const moving = snap.aircraft.filter((a) => a.groundspeed > 0).length
          const mm = String(Math.floor(snap.time / 60)).padStart(2, '0')
          const ss = String(Math.floor(snap.time % 60)).padStart(2, '0')
          statusRef.current.textContent = `${moving} taxiing · ${snap.aircraft.length} on surface · dep ${snap.departed} · arr ${snap.arrived} · T+${mm}:${ss}`
        }
        if (hintRef.current) {
          if (selected?.holdShort) {
            hintRef.current.textContent = `${selected.callsign} holding short of the runway — press C to clear across · Esc to deselect`
          } else if (selected) {
            hintRef.current.textContent = `${selected.callsign} selected — click a point to assign taxi · right-click to hold · Esc to deselect`
          } else {
            hintRef.current.textContent = 'click an aircraft (scope or strip) to select · drag to pan · scroll to zoom'
          }
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
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKey)
    }
  }, [controller])

  return (
    <div className="scope">
      <canvas ref={canvasRef} className="scope-canvas" />
      <div className="hud hud-tl">
        <div className="hud-title">KSAN · SAN DIEGO INTL</div>
        <div className="hud-sub">GND CON 123.9 · D-ATIS 134.8 · SURFACE (ASDE-X)</div>
      </div>
      <div ref={statusRef} className="hud hud-tr mono" />
      <div ref={hintRef} className="hud hud-bc mono" />
    </div>
  )
}
