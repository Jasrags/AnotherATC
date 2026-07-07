import type { AirportSurface, GroundAircraft, SurfaceFeature, SurfaceKind } from '@anotheratc/sim'
import { COLORS, DIMS } from './palette'
import { toScreen, type View } from './view'

type Ctx = CanvasRenderingContext2D

interface StrokeOpts {
  /** Pavement width in nm (scales with zoom). */
  nm?: number
  /** Fixed pixel width (for centerlines); overrides nm. */
  px?: number
  minPx?: number
  dash?: number[]
}

function trace(ctx: Ctx, v: View, points: SurfaceFeature['points']): void {
  let started = false
  for (const p of points) {
    if (!p) continue
    const [sx, sy] = toScreen(v, p[0], p[1])
    if (!started) {
      ctx.moveTo(sx, sy)
      started = true
    } else {
      ctx.lineTo(sx, sy)
    }
  }
}

function byKind(surface: AirportSurface, ...kinds: SurfaceKind[]): SurfaceFeature[] {
  const set = new Set(kinds)
  return surface.features.filter((f) => set.has(f.kind))
}

function fillPolys(ctx: Ctx, v: View, feats: SurfaceFeature[], fill: string, edge: string): void {
  ctx.setLineDash([])
  ctx.lineWidth = 1
  ctx.strokeStyle = edge
  ctx.fillStyle = fill
  for (const f of feats) {
    ctx.beginPath()
    trace(ctx, v, f.points)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

/** Stroke every feature with a single uniform width for the pass (ignores per-feature width). */
function strokeFeatures(ctx: Ctx, v: View, feats: SurfaceFeature[], color: string, opts: StrokeOpts): void {
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(opts.dash ?? [])
  ctx.lineWidth = opts.px ?? Math.max((opts.nm ?? 0) * v.scale, opts.minPx ?? 1)
  for (const f of feats) {
    ctx.beginPath()
    trace(ctx, v, f.points)
    ctx.stroke()
  }
}

export function drawSurface(ctx: Ctx, v: View, surface: AirportSurface, w: number, h: number): void {
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, w, h)

  fillPolys(ctx, v, byKind(surface, 'apron'), COLORS.apronFill, COLORS.apronEdge)
  fillPolys(ctx, v, byKind(surface, 'terminal', 'hangar'), COLORS.buildingFill, COLORS.buildingEdge)

  // gate stands
  strokeFeatures(ctx, v, byKind(surface, 'parking_position'), COLORS.stand, { nm: DIMS.standNm, minPx: 0.75 })

  // taxiways: pavement then a thin centerline
  const taxi = byKind(surface, 'taxiway', 'taxilane')
  strokeFeatures(ctx, v, taxi, COLORS.taxiway, { nm: DIMS.taxiwayNm, minPx: 1.5 })
  strokeFeatures(ctx, v, taxi, COLORS.taxiwayCenter, { px: 0.8 })

  // runway: edge outline, pavement, dashed centerline
  const rwy = byKind(surface, 'runway', 'stopway')
  strokeFeatures(ctx, v, rwy, COLORS.runwayEdge, { nm: DIMS.runwayNm + 0.003, minPx: 4 })
  strokeFeatures(ctx, v, rwy, COLORS.runway, { nm: DIMS.runwayNm, minPx: 3 })
  strokeFeatures(ctx, v, byKind(surface, 'runway'), COLORS.runwayCenter, { px: 1.2, dash: [11, 9] })
  ctx.setLineDash([])

  // hold-short markers (nodes)
  ctx.fillStyle = COLORS.holdShort
  for (const f of byKind(surface, 'holding_position')) {
    const p = f.points[0]
    if (!p) continue
    const [sx, sy] = toScreen(v, p[0], p[1])
    ctx.beginPath()
    ctx.rect(sx - 1.6, sy - 1.6, 3.2, 3.2)
    ctx.fill()
  }
}

export function drawAircraft(ctx: Ctx, v: View, aircraft: GroundAircraft[]): void {
  ctx.setLineDash([])
  ctx.font = `${DIMS.blockFont}px ui-monospace, "SF Mono", Menlo, monospace`
  ctx.textBaseline = 'alphabetic'

  for (const ac of aircraft) {
    const [sx, sy] = toScreen(v, ac.x, ac.y)
    const rad = (ac.heading * Math.PI) / 180

    // projected-track (velocity vector): a few seconds of travel at current groundspeed
    if (ac.groundspeed >= DIMS.ptlMinSpeedKt) {
      const nm = ac.groundspeed * (DIMS.ptlSeconds / 3600)
      const [lx, ly] = toScreen(v, ac.x + Math.sin(rad) * nm, ac.y + Math.cos(rad) * nm)
      ctx.strokeStyle = COLORS.leader
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(lx, ly)
      ctx.stroke()
    }

    // target blip
    const r = DIMS.targetR
    ctx.save()
    if (!ac.holding) {
      ctx.shadowColor = COLORS.targetHalo
      ctx.shadowBlur = 7
    }
    ctx.fillStyle = ac.holding ? COLORS.targetHold : COLORS.target
    ctx.beginPath()
    ctx.rect(sx - r, sy - r, r * 2, r * 2)
    ctx.fill()
    ctx.restore()

    // data block, offset up-right, with a thin connector
    const bx = sx + DIMS.blockLeader
    const by = sy - DIMS.blockLeader
    ctx.strokeStyle = COLORS.connector
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(bx, by)
    ctx.stroke()

    const wake = ac.wake === 'H' ? ' H' : ac.wake === 'J' ? ' J' : ''
    ctx.fillStyle = COLORS.block1
    ctx.fillText(`${ac.callsign}${wake}`, bx, by)
    const speed = ac.holding ? '--' : String(ac.groundspeed).padStart(2, '0')
    ctx.fillStyle = COLORS.block2
    ctx.fillText(`${ac.type}  ${speed}`, bx, by + DIMS.blockFont + 1)
  }
}
