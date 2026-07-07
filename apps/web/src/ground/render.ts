import type { AirportSurface, GroundAircraft, Point, SurfaceFeature, SurfaceKind } from '@anotheratc/sim'
import { COLORS, DIMS } from './palette'
import { toScreen, type View } from './view'

type Ctx = CanvasRenderingContext2D

function polylineLength(points: SurfaceFeature['points']): number {
  let d = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (a && b) d += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return d
}

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

/** One label per taxiway designator (at its longest segment) + runway numbers. */
export function drawLabels(ctx: Ctx, v: View, surface: AirportSurface): void {
  const best = new Map<string, { len: number; mid: Point }>()
  for (const f of surface.features) {
    if (f.kind !== 'taxiway' || !f.ref) continue
    const mid = f.points[Math.floor(f.points.length / 2)]
    if (!mid) continue
    const len = polylineLength(f.points)
    const cur = best.get(f.ref)
    if (!cur || len > cur.len) best.set(f.ref, { len, mid })
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace'
  ctx.fillStyle = COLORS.labelTaxi
  for (const [ref, { mid }] of best) {
    const [sx, sy] = toScreen(v, mid[0], mid[1])
    ctx.fillText(ref, sx, sy)
  }

  // runway numbers at the two thresholds (9 = west end, 27 = east end)
  let west: Point | null = null
  let east: Point | null = null
  for (const f of surface.features) {
    if (f.kind !== 'runway') continue
    for (const p of f.points) {
      if (!p) continue
      if (!west || p[0] < west[0]) west = p
      if (!east || p[0] > east[0]) east = p
    }
  }
  ctx.fillStyle = COLORS.labelRwy
  ctx.font = 'bold 13px ui-monospace, "SF Mono", Menlo, monospace'
  if (west) {
    const [sx, sy] = toScreen(v, west[0], west[1])
    ctx.fillText('9', sx - 12, sy)
  }
  if (east) {
    const [sx, sy] = toScreen(v, east[0], east[1])
    ctx.fillText('27', sx + 14, sy)
  }

  ctx.textAlign = 'left'
}

/** Highlight the selected aircraft and its remaining route. */
export function drawSelection(
  ctx: Ctx,
  v: View,
  selected: GroundAircraft | undefined,
  route: Point[],
): void {
  if (!selected) return

  if (route.length >= 2) {
    ctx.strokeStyle = COLORS.route
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash([7, 6])
    ctx.beginPath()
    let started = false
    for (const p of route) {
      const [sx, sy] = toScreen(v, p[0], p[1])
      if (!started) {
        ctx.moveTo(sx, sy)
        started = true
      } else {
        ctx.lineTo(sx, sy)
      }
    }
    ctx.stroke()
    ctx.setLineDash([])
    const dest = route[route.length - 1]
    if (dest) {
      const [dx, dy] = toScreen(v, dest[0], dest[1])
      ctx.fillStyle = COLORS.routeDest
      ctx.beginPath()
      ctx.arc(dx, dy, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const [sx, sy] = toScreen(v, selected.x, selected.y)
  ctx.strokeStyle = COLORS.selection
  ctx.lineWidth = 1.6
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(sx, sy, 11, 0, Math.PI * 2)
  ctx.stroke()
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
