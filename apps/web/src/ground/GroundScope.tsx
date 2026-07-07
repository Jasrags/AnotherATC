import { useEffect, useRef } from 'react'
import { KSAN_SURFACE, buildKsanGroundScenario, createGroundSim } from '@anotheratc/sim'
import { fitView, pan, zoomAt, type View } from './view'
import { drawAircraft, drawSurface } from './render'

/** Fixed simulation timestep (seconds) — decoupled from the render framerate. */
const FIXED_DT = 0.05

export function GroundScope() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const status = statusRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const sim = createGroundSim(buildKsanGroundScenario(1))

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

    // pan + zoom
    let dragging = false
    let lastX = 0
    let lastY = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!view) return
      const rect = canvas.getBoundingClientRect()
      view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    const onDown = (e: PointerEvent) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging || !view) return
      view = pan(view, e.clientX - lastX, e.clientY - lastY)
      lastX = e.clientX
      lastY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      dragging = false
      canvas.releasePointerCapture(e.pointerId)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)

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

      if (view) {
        ctx.save()
        ctx.scale(dpr, dpr)
        const snap = sim.snapshot()
        drawSurface(ctx, view, KSAN_SURFACE, width, height)
        drawAircraft(ctx, view, snap.aircraft)
        ctx.restore()

        if (status) {
          const moving = snap.aircraft.filter((a) => a.groundspeed > 0).length
          const mm = String(Math.floor(snap.time / 60)).padStart(2, '0')
          const ss = String(Math.floor(snap.time % 60)).padStart(2, '0')
          status.textContent = `${moving} taxiing · ${snap.aircraft.length} on surface · T+${mm}:${ss}`
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
    }
  }, [])

  return (
    <div className="scope">
      <canvas ref={canvasRef} className="scope-canvas" />
      <div className="hud hud-tl">
        <div className="hud-title">KSAN · SAN DIEGO INTL</div>
        <div className="hud-sub">GND CON 123.9 · D-ATIS 134.8 · SURFACE (ASDE-X)</div>
      </div>
      <div ref={statusRef} className="hud hud-tr mono" />
      <div className="hud hud-bl mono">drag to pan · scroll to zoom · geometry © OpenStreetMap</div>
    </div>
  )
}
