import { useEffect, useRef } from 'react'
import { createTerminalSim, type Airport, type Point } from '@anotheratc/sim'
import { fitPoints, reframe, type View } from '../ground/view'
import { FIXED_DT, tick } from '../ground/simClock'
import { demoArrivalInit } from './scene'
import { drawTerminalScene } from './render'

interface TerminalScopeProps {
  airport: Airport
}

/** The centre of the airport surface bounds — the field reference the range rings sit on. */
function fieldCenter(airport: Airport): Point {
  const { minX, minY, maxX, maxY } = airport.surface.bounds
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

/**
 * The TRACON terminal radar scope (docs/atc-tracon.md, Slice 1). Render-only this slice: it runs the
 * deterministic terminal sim with one arrival entering at a feeder-fix-like point and draws the radar
 * picture each frame — targets, history trails, velocity vectors, and data blocks. Vectoring (the
 * player turning a blip) arrives in Slice 2; the sim already accepts a heading command underneath.
 */
export function TerminalScope({ airport }: TerminalScopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Building the demo arrival throws if the field has no resolvable active runway. Unreachable for
    // the fields shipped today, but a landmine for the next airport added — surface it on the scope
    // rather than crashing the effect into a blank canvas (a useEffect throw escapes error boundaries).
    let sim: ReturnType<typeof createTerminalSim>
    try {
      sim = createTerminalSim([demoArrivalInit(airport)])
    } catch (err) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#02060a'
      ctx.fillRect(0, 0, rect.width, rect.height)
      ctx.fillStyle = '#8ef0b4'
      ctx.font = '13px ui-monospace, "SF Mono", Menlo, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`TRACON scope unavailable — ${err instanceof Error ? err.message : String(err)}`, rect.width / 2, rect.height / 2)
      return
    }

    const center = fieldCenter(airport)

    let width = 0
    let height = 0
    let view: View | null = null

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const newW = rect.width
      const newH = rect.height
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(newW * dpr)
      canvas.height = Math.round(newH * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // First layout frames the field plus the traffic (well outside the surface bounds); later
      // resizes hold the world point at screen centre so a reflow keeps the picture steady.
      const snap = sim.snapshot()
      view = view
        ? reframe(view, width, height, newW, newH)
        : fitPoints(airport.surface.bounds, snap.aircraft.map((a) => a.position), newW, newH)
      width = newW
      height = newH
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    let raf = 0
    let last = 0
    let started = false
    let acc = 0

    const frame = (t: number) => {
      if (!started) {
        last = t
        started = true
      }
      const t0 = tick(acc, (t - last) / 1000, 1)
      last = t
      acc = t0.acc
      for (let i = 0; i < t0.steps; i += 1) sim.step(FIXED_DT)

      if (view) drawTerminalScene(ctx, view, sim.snapshot(), width, height, center)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [airport])

  return (
    <canvas
      ref={canvasRef}
      className="terminal-scope"
      role="application"
      aria-label={`TRACON terminal radar scope for ${airport.name}`}
      tabIndex={0}
    />
  )
}
