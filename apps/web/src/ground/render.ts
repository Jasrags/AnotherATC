import type {
  AirportSurface,
  ApproachConfig,
  GroundAircraft,
  RunwayExit,
  Point,
  SurfaceFeature,
  SurfaceKind,
  TaxiTopology,
} from '@anotheratc/sim'
import { COLORS, DIMS } from './palette'
import { toScreen, type View } from './view'

type Ctx = CanvasRenderingContext2D

export function polylineLength(points: SurfaceFeature['points']): number {
  let d = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (a && b) d += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return d
}

/** The point halfway along a polyline by arc length (consistent regardless of vertex count). */
export function polylineMidpoint(points: SurfaceFeature['points']): Point | null {
  const total = polylineLength(points)
  if (total === 0) return points[0] ?? null
  const half = total / 2
  let acc = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (!a || !b) continue
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (acc + seg >= half) {
      const t = (half - acc) / seg
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    acc += seg
  }
  return points[points.length - 1] ?? null
}

interface StrokeOpts {
  /** Pavement width in nm (scales with zoom). */
  nm?: number
  /** Fixed pixel width (for centerlines); overrides nm. */
  px?: number
  minPx?: number
  dash?: number[]
  /** Line cap. Taxiways round off where they meet; a runway ends square — a rounded cap draws
   *  a half-disc of pavement past the threshold that is not there on any airport diagram. */
  cap?: CanvasLineCap
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
  ctx.lineCap = opts.cap ?? 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(opts.dash ?? [])
  ctx.lineWidth = opts.px ?? Math.max((opts.nm ?? 0) * v.scale, opts.minPx ?? 1)
  for (const f of feats) {
    ctx.beginPath()
    trace(ctx, v, f.points)
    ctx.stroke()
  }
}

export function drawSurface(ctx: Ctx, v: View, prep: PreparedSurface, w: number, h: number): void {
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, w, h)

  fillPolys(ctx, v, prep.apron, COLORS.apronFill, COLORS.apronEdge)
  fillPolys(ctx, v, prep.buildings, COLORS.buildingFill, COLORS.buildingEdge)

  // gate stands are drawn as markers in drawGates (cleaner than the tangle of
  // OSM parking guidance lines).

  // taxiways: pavement then a thin centerline
  strokeFeatures(ctx, v, prep.taxiways, COLORS.taxiway, { nm: DIMS.taxiwayNm, minPx: 1.5 })
  strokeFeatures(ctx, v, prep.taxiways, COLORS.taxiwayCenter, { px: 0.8 })

  // runway: edge outline, pavement, dashed centerline
  strokeFeatures(ctx, v, prep.runwayPavement, COLORS.runwayEdge, {
    nm: DIMS.runwayNm + 0.003,
    minPx: 4,
    cap: 'butt',
  })
  strokeFeatures(ctx, v, prep.runwayPavement, COLORS.runway, { nm: DIMS.runwayNm, minPx: 3, cap: 'butt' })
  strokeFeatures(ctx, v, prep.runwayCenterlines, COLORS.runwayCenter, { px: 1.2, dash: [11, 9] })
  ctx.setLineDash([])
  drawThresholds(ctx, v, prep.runwayPavement)

  // hold-short markers (nodes)
  ctx.fillStyle = COLORS.holdShort
  for (const p of prep.holdShort) {
    const [sx, sy] = toScreen(v, p[0], p[1])
    ctx.beginPath()
    ctx.rect(sx - 1.6, sy - 1.6, 3.2, 3.2)
    ctx.fill()
  }
}

/** Threshold markings: the solid bar across each runway end. With square-capped pavement this
 *  is what makes an end read as a threshold rather than as pavement that simply stops. */
function drawThresholds(ctx: Ctx, v: View, runways: SurfaceFeature[]): void {
  ctx.save()
  ctx.setLineDash([])
  ctx.lineCap = 'butt'
  ctx.strokeStyle = COLORS.runwayThreshold
  const half = (DIMS.runwayNm / 2) * v.scale
  for (const f of runways) {
    for (const end of [
      { at: f.points[0], toward: f.points[1] },
      { at: f.points[f.points.length - 1], toward: f.points[f.points.length - 2] },
    ]) {
      const { at, toward } = end
      if (!at || !toward) continue
      const [ax, ay] = toScreen(v, at[0], at[1])
      const [bx, by] = toScreen(v, toward[0], toward[1])
      const dx = bx - ax
      const dy = by - ay
      const len = Math.hypot(dx, dy)
      if (len < 1e-6 || half < 2) continue
      // A bar across the full runway width, set just inside the end.
      const inset = Math.min(len, DIMS.thresholdInsetPx)
      const cx = ax + (dx / len) * inset
      const cy = ay + (dy / len) * inset
      ctx.lineWidth = Math.max(2, DIMS.thresholdBarPx)
      ctx.beginPath()
      ctx.moveTo(cx - (dy / len) * half, cy + (dx / len) * half)
      ctx.lineTo(cx + (dy / len) * half, cy - (dx / len) * half)
      ctx.stroke()
    }
  }
  ctx.restore()
}

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const l2 = vx * vx + vy * vy
  let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/** Closest point on any runway centerline to p (null if there are no runways). */
function nearestRunwayPoint(p: Point, runways: SurfaceFeature[]): Point | null {
  let best: Point | null = null
  let bestD = Infinity
  for (const f of runways) {
    for (let i = 1; i < f.points.length; i += 1) {
      const a = f.points[i - 1]
      const b = f.points[i]
      if (!a || !b) continue
      const vx = b[0] - a[0]
      const vy = b[1] - a[1]
      const l2 = vx * vx + vy * vy
      let t = l2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const cx = a[0] + t * vx
      const cy = a[1] + t * vy
      const d = Math.hypot(p[0] - cx, p[1] - cy)
      if (d < bestD) {
        bestD = d
        best = [cx, cy]
      }
    }
  }
  return best
}

/** Draw crisp label text with a dark halo so it reads on any surface. */
function label(ctx: Ctx, text: string, x: number, y: number, color: string): void {
  ctx.lineWidth = 3
  ctx.strokeStyle = COLORS.labelHalo
  ctx.strokeText(text, Math.round(x), Math.round(y))
  ctx.fillStyle = color
  ctx.fillText(text, Math.round(x), Math.round(y))
}

/** Per-area label nudges (nm) where the centroid overlaps gates/pavement. */
const AREA_OFFSET_NM: Record<string, Point> = {
  'Terminal 2 West': [0, -0.05],
  'Terminal 2 East': [0, -0.05],
}

/** Ramp / terminal / apron area names, centered on each named area. */
export function drawAreaLabels(ctx: Ctx, v: View, prep: PreparedSurface): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif'
  for (const { text, at } of prep.areaLabels) {
    const [sx, sy] = toScreen(v, at[0], at[1])
    label(ctx, text, sx, sy, COLORS.labelArea)
  }
  ctx.textAlign = 'left'
}

/** Gate/stand numbers — only when zoomed in enough to read them (else they'd be a blur). */
const GATE_LABEL_SCALE = 2400

interface Stand {
  ref: string
  point: Point
}

/** One numbered stand per gate: prefer the OSM gate node (terminal gates), fall
 *  back to a parking line's midpoint for numbered cargo/remote stands. Untagged
 *  parking positions are skipped (they'd just be unlabeled squares). */
function collectStands(surface: AirportSurface): Stand[] {
  const stands: Stand[] = []
  const seen = new Set<string>()
  for (const f of surface.features) {
    if (f.kind !== 'gate' || !f.ref) continue
    const p = f.points[0]
    if (!p || seen.has(f.ref)) continue
    seen.add(f.ref)
    stands.push({ ref: f.ref, point: p })
  }
  for (const f of surface.features) {
    if (f.kind !== 'parking_position' || !f.ref || seen.has(f.ref)) continue
    const m = polylineMidpoint(f.points)
    if (!m) continue
    seen.add(f.ref)
    stands.push({ ref: f.ref, point: m })
  }
  return stands
}

interface LabelAnchor {
  text: string
  /** World-space (nm) anchor; the frame loop applies the current view transform. */
  at: Point
}

/** A runway number plus the pixel offset that nudges it clear of the threshold. */
interface RunwayNumber extends LabelAnchor {
  dx: number
}

/**
 * All surface-derived draw data — feature buckets and world-space label anchors — computed
 * once per surface. The surface is static, so only the view transform and the aircraft change
 * per frame; the frame loop reuses this instead of re-filtering features and rebuilding Maps
 * ~60×/sec (WEB-1). Build it once (e.g. `useMemo`) and pass it to the static draw calls.
 */
export interface PreparedSurface {
  apron: SurfaceFeature[]
  buildings: SurfaceFeature[]
  taxiways: SurfaceFeature[]
  runwayPavement: SurfaceFeature[]
  runwayCenterlines: SurfaceFeature[]
  holdShort: Point[]
  areaLabels: LabelAnchor[]
  stands: Stand[]
  taxiLabels: LabelAnchor[]
  runwayNumbers: RunwayNumber[]
}

export function prepareSurface(surface: AirportSurface): PreparedSurface {
  const runways = surface.features.filter((f) => f.kind === 'runway')

  const holdShort: Point[] = []
  for (const f of byKind(surface, 'holding_position')) {
    const p = f.points[0]
    if (p) holdShort.push(p)
  }

  // Ramp / terminal / apron area names, centered on each named area.
  const groups = new Map<string, { x: number; y: number; n: number }>()
  for (const f of surface.features) {
    if ((f.kind !== 'terminal' && f.kind !== 'apron') || !f.ref) continue
    let cx = 0
    let cy = 0
    let n = 0
    for (const p of f.points) {
      if (!p) continue
      cx += p[0]
      cy += p[1]
      n += 1
    }
    if (n === 0) continue
    const g = groups.get(f.ref) ?? { x: 0, y: 0, n: 0 }
    g.x += cx / n
    g.y += cy / n
    g.n += 1
    groups.set(f.ref, g)
  }
  const areaLabels: LabelAnchor[] = []
  for (const [name, g] of groups) {
    const off = AREA_OFFSET_NM[name] ?? [0, 0]
    areaLabels.push({ text: name.toUpperCase(), at: [g.x / g.n + off[0], g.y / g.n + off[1]] })
  }

  // nm distance from a point to the nearest runway centerline — used to keep labels off the runway
  const nearRunway = (p: Point): boolean => {
    for (const f of runways) {
      for (let i = 1; i < f.points.length; i += 1) {
        const a = f.points[i - 1]
        const b = f.points[i]
        if (a && b && distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]) < 0.03) return true
      }
    }
    return false
  }

  // One anchor per taxiway ref: prefer a midpoint off the runway, then the longest segment.
  const best = new Map<string, { score: number; mid: Point }>()
  for (const f of surface.features) {
    if ((f.kind !== 'taxiway' && f.kind !== 'taxilane') || !f.ref) continue
    const mid = f.points[Math.floor(f.points.length / 2)]
    if (!mid) continue
    const score = (nearRunway(mid) ? 0 : 1e6) + polylineLength(f.points)
    const cur = best.get(f.ref)
    if (!cur || score > cur.score) best.set(f.ref, { score, mid })
  }
  const taxiLabels: LabelAnchor[] = []
  for (const [ref, { mid }] of best) {
    // If the anchor sits on/near the runway, nudge it clear of the pavement so
    // runway connectors (C1, C6, …) stay labeled and readable.
    let anchor = mid
    const np = nearestRunwayPoint(mid, runways)
    if (np) {
      const d = Math.hypot(mid[0] - np[0], mid[1] - np[1])
      if (d < 0.045) {
        const ux = d > 1e-6 ? (mid[0] - np[0]) / d : 0
        const uy = d > 1e-6 ? (mid[1] - np[1]) / d : 1
        anchor = [np[0] + ux * 0.06, np[1] + uy * 0.06]
      }
    }
    taxiLabels.push({ text: ref, at: anchor })
  }

  // runway numbers at the two thresholds (9 = west end, 27 = east end)
  let west: Point | null = null
  let east: Point | null = null
  for (const f of runways) {
    for (const p of f.points) {
      if (!p) continue
      if (!west || p[0] < west[0]) west = p
      if (!east || p[0] > east[0]) east = p
    }
  }
  const runwayNumbers: RunwayNumber[] = []
  if (west) runwayNumbers.push({ text: '9', at: west, dx: -12 })
  if (east) runwayNumbers.push({ text: '27', at: east, dx: 14 })

  return {
    apron: byKind(surface, 'apron'),
    buildings: byKind(surface, 'terminal', 'hangar'),
    taxiways: byKind(surface, 'taxiway', 'taxilane'),
    runwayPavement: byKind(surface, 'runway', 'stopway'),
    runwayCenterlines: runways,
    holdShort,
    areaLabels,
    stands: collectStands(surface),
    taxiLabels,
    runwayNumbers,
  }
}

export function drawGates(ctx: Ctx, v: View, prep: PreparedSurface): void {
  ctx.fillStyle = COLORS.gateNode
  for (const s of prep.stands) {
    const [sx, sy] = toScreen(v, s.point[0], s.point[1])
    ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3)
  }

  if (v.scale < GATE_LABEL_SCALE) return
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.font = '600 9px ui-monospace, "SF Mono", Menlo, monospace'
  for (const s of prep.stands) {
    const [sx, sy] = toScreen(v, s.point[0], s.point[1])
    label(ctx, s.ref.toUpperCase(), sx, sy - 7, COLORS.gateLabel)
  }
  ctx.textAlign = 'left'
}

/** Charted runway-incursion hot spots (dashed orange circle + id). */
export function drawHotspots(ctx: Ctx, v: View, surface: AirportSurface): void {
  if (!surface.hotspots) return
  for (const hs of surface.hotspots) {
    const [sx, sy] = toScreen(v, hs.point[0], hs.point[1])
    const r = Math.max(hs.radiusNm * v.scale, 10)
    ctx.strokeStyle = COLORS.hotspot
    ctx.lineWidth = 1.6
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '700 10px ui-monospace, "SF Mono", Menlo, monospace'
    label(ctx, hs.id, sx, sy - r - 8, COLORS.hotspot)
    ctx.textAlign = 'left'
  }
}

/** Taxiway designator (kept off the runway) + runway numbers, with halos. */
export function drawLabels(ctx: Ctx, v: View, prep: PreparedSurface): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, monospace'
  for (const { text, at } of prep.taxiLabels) {
    const [sx, sy] = toScreen(v, at[0], at[1])
    label(ctx, text, sx, sy, COLORS.labelTaxi)
  }

  ctx.font = '700 13px ui-monospace, "SF Mono", Menlo, monospace'
  for (const { text, at, dx } of prep.runwayNumbers) {
    const [sx, sy] = toScreen(v, at[0], at[1])
    label(ctx, text, sx + dx, sy, COLORS.labelRwy)
  }

  ctx.textAlign = 'left'
}

/** Distances within this (nm) count as a tie — resolved in favor of the longer taxiway. */
const TAXI_TIE_NM = 0.005

/**
 * The designator of the named taxiway nearest a world point, within `maxNm`; null if none.
 * On a near-tie (a junction where two legs are ~equidistant) the longer taxiway wins, so
 * clicking an intersection deterministically picks the through-taxiway over a stub.
 */
export function nearestTaxiwayRef(
  surface: AirportSurface,
  wx: number,
  wy: number,
  maxNm: number,
): string | null {
  let best: string | null = null
  let bestD = maxNm
  let bestLen = 0
  for (const f of surface.features) {
    if ((f.kind !== 'taxiway' && f.kind !== 'taxilane') || !f.ref) continue
    let d = Infinity
    for (let i = 1; i < f.points.length; i += 1) {
      const a = f.points[i - 1]
      const b = f.points[i]
      if (a && b) d = Math.min(d, distToSeg(wx, wy, a[0], a[1], b[0], b[1]))
    }
    if (d > maxNm) continue
    const len = polylineLength(f.points)
    // Clearly nearer wins; within a tie window the longer leg wins.
    if (best === null || d < bestD - TAXI_TIE_NM || (d <= bestD + TAXI_TIE_NM && len > bestLen)) {
      best = f.ref
      bestD = Math.min(bestD, d)
      bestLen = len
    }
  }
  return best
}

/** Stroke every segment of the taxiways in `set` in one style. */
function strokeTaxiways(
  ctx: Ctx,
  v: View,
  surface: AirportSurface,
  set: Set<string>,
  color: string,
  width: number,
  alpha: number,
  dash: number[] = [],
): void {
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(dash)
  ctx.globalAlpha = alpha
  for (const f of surface.features) {
    if ((f.kind !== 'taxiway' && f.kind !== 'taxilane') || !f.ref || !set.has(f.ref)) continue
    ctx.beginPath()
    trace(ctx, v, f.points)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
}

/** Highlight every segment of the taxiways in `via` — the route being assembled by clicks. */
export function drawRouteDraft(ctx: Ctx, v: View, surface: AirportSurface, via: string[]): void {
  if (via.length === 0) return
  strokeTaxiways(ctx, v, surface, new Set(via), COLORS.routeVia, 3, 0.85)
}

/** Faint preview of the taxiway a click would pick right now (hover feedback in route mode). */
export function drawRouteHover(ctx: Ctx, v: View, surface: AirportSurface, ref: string): void {
  strokeTaxiways(ctx, v, surface, new Set([ref]), COLORS.routeVia, 2.5, 0.4, [4, 5])
}

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

/**
 * The straight-in final: the runway centerline extended out to the fix arrivals appear at,
 * with a range tick every nautical mile. A scope framed to the airport shows none of the
 * approach, so without this the controller is clearing traffic to land that has no visible
 * relationship to the field.
 */
export function drawApproachCourse(ctx: Ctx, v: View, approach: ApproachConfig): void {
  const { fix, threshold } = approach
  const dx = fix[0] - threshold[0]
  const dy = fix[1] - threshold[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return
  const [fx, fy] = toScreen(v, fix[0], fix[1])
  const [tx, ty] = toScreen(v, threshold[0], threshold[1])

  ctx.save()
  ctx.strokeStyle = COLORS.approachCourse
  ctx.lineWidth = 1
  ctx.setLineDash([8, 8])
  ctx.beginPath()
  ctx.moveTo(fx, fy)
  ctx.lineTo(tx, ty)
  ctx.stroke()

  // Range ticks, drawn across the course every nm from the threshold outward.
  ctx.setLineDash([])
  ctx.strokeStyle = COLORS.approachTick
  const ux = dx / len
  const uy = dy / len
  const half = DIMS.approachTickNm
  for (let nm = 1; nm <= len + 1e-9; nm += 1) {
    const px = threshold[0] + ux * nm
    const py = threshold[1] + uy * nm
    const [ax, ay] = toScreen(v, px - uy * half, py + ux * half)
    const [bx, by] = toScreen(v, px + uy * half, py - ux * half)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * The runway turnoffs available to the selected arrival, with the assigned one emphasized.
 * A rapid exit is drawn along its real acute geometry so the shape reads as what it is — the
 * reason it can be taken at speed — rather than as an anonymous tick on the runway.
 */
export function drawRunwayExits(
  ctx: Ctx,
  v: View,
  exits: readonly RunwayExit[],
  assignedRef: string | null,
): void {
  ctx.save()
  ctx.font = `${DIMS.blockFont - 1}px ui-monospace, "SF Mono", Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const e of exits) {
    const on = e.ref === assignedRef
    // The assigned turnoff is part of the aircraft's cleared path, so it is drawn exactly like
    // the rest of the route: same dash, same colour. Alternatives sit behind it, dimmer.
    ctx.strokeStyle = on ? COLORS.route : COLORS.exitAvailable
    ctx.lineWidth = on ? 2 : 1.2
    ctx.setLineDash(on ? [7, 6] : [3, 5])
    ctx.beginPath()
    let started = false
    for (const p of e.geom) {
      const [sx, sy] = toScreen(v, p[0], p[1])
      if (started) ctx.lineTo(sx, sy)
      else {
        ctx.moveTo(sx, sy)
        started = true
      }
    }
    ctx.stroke()
    ctx.setLineDash([])

    const end = e.geom[e.geom.length - 1]
    const before = e.geom[e.geom.length - 2]
    if (!end || !before) continue
    const [bx, by] = toScreen(v, end[0], end[1])
    const [px, py] = toScreen(v, before[0], before[1])
    const dx = bx - px
    const dy = by - py
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue // degenerate turnoff — nothing to label
    ctx.fillStyle = on ? COLORS.routeDest : COLORS.exitAvailable
    ctx.fillText(e.ref, bx + (dx / len) * 14, by + (dy / len) * 14)
  }
  ctx.restore()
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)

/**
 * Edge markers for airborne traffic outside the viewport. The final starts several nm off
 * the field, so on a scope framed to the airport an inbound is off-screen for most of its
 * approach — this keeps its bearing, callsign and range in view without forcing the
 * controller to zoom out and lose the surface.
 */
export function drawOffscreenTraffic(
  ctx: Ctx,
  v: View,
  aircraft: GroundAircraft[],
  width: number,
  height: number,
): void {
  const pad = DIMS.edgeMarkerPad
  ctx.save()
  ctx.font = `${DIMS.blockFont}px ui-monospace, "SF Mono", Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const ac of aircraft) {
    if (ac.altitude <= 0) continue
    const [sx, sy] = toScreen(v, ac.x, ac.y)
    if (sx >= 0 && sx <= width && sy >= 0 && sy <= height) continue
    const cx = clamp(sx, pad, width - pad)
    const cy = clamp(sy, pad, height - pad)
    const ang = Math.atan2(sy - cy, sx - cx) // points out toward the true position

    ctx.fillStyle = COLORS.airborneTarget
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(ang)
    ctx.beginPath()
    ctx.moveTo(9, 0)
    ctx.lineTo(-5, 6)
    ctx.lineTo(-5, -6)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // Label inboard of the chevron, so it never runs off the edge it is pinned to.
    ctx.fillText(`${ac.callsign} ${ac.finalNm.toFixed(1)}`, cx - Math.cos(ang) * 30, cy - Math.sin(ang) * 30)
  }
  ctx.restore()
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

    // target blip — hollow for traffic on final (it's over the field, not on it), amber
    // when holding short of a runway, otherwise a filled surface target.
    const r = DIMS.targetR
    if (ac.altitude > 0) {
      ctx.strokeStyle = COLORS.airborneTarget
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(sx, sy, r + 1, 0, Math.PI * 2)
      ctx.stroke()
      drawDataBlock(ctx, ac, sx, sy)
      continue
    }
    ctx.save()
    if (!ac.holding) {
      ctx.shadowColor = COLORS.targetHalo
      ctx.shadowBlur = 7
    } else if (ac.holdShort) {
      ctx.shadowColor = COLORS.holdShortTarget
      ctx.shadowBlur = 8
    }
    ctx.fillStyle = ac.holdShort ? COLORS.holdShortTarget : ac.holding ? COLORS.targetHold : COLORS.target
    ctx.beginPath()
    ctx.rect(sx - r, sy - r, r * 2, r * 2)
    ctx.fill()
    ctx.restore()

    // separation conflict alert
    if (ac.conflict) {
      ctx.strokeStyle = COLORS.conflict
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2)
      ctx.stroke()
    }

    drawDataBlock(ctx, ac, sx, sy)
  }
}

/** The two-line data block beside a target, with its leader line. Line 2 carries the
 *  phase-relevant readout: hold-short state, or altitude/range on final, else type + speed. */
function drawDataBlock(ctx: Ctx, ac: GroundAircraft, sx: number, sy: number): void {
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
  const line2 = by + DIMS.blockFont + 1
  if (ac.altitude > 0) {
    // Altitude in hundreds of feet, ATC data-block style, plus range to the threshold.
    ctx.fillStyle = COLORS.airborneTarget
    const hundreds = String(Math.round(ac.altitude / 100)).padStart(3, '0')
    ctx.fillText(`${hundreds}↓ ${ac.finalNm.toFixed(1)}`, bx, line2)
  } else if (ac.holdShort) {
    ctx.fillStyle = COLORS.holdShortTarget
    ctx.fillText('HOLD SHORT', bx, line2)
  } else {
    const speed = ac.holding ? '--' : String(ac.groundspeed).padStart(2, '0')
    ctx.fillStyle = COLORS.block2
    ctx.fillText(`${ac.type}  ${speed}`, bx, line2)
  }
}

/**
 * Admin debug layer: the routing graph the sim actually navigates, drawn over the
 * surface. Contracted edges follow their real polyline; long dead-straight runs are
 * flagged (they're either legitimate straight taxiway or an OSM digitization gap that
 * cuts a corner). Junction nodes are emphasized over plain endpoints. Toggle with the
 * Graph control (or "g"); use it to eyeball where routing geometry diverges from the chart.
 */
export function drawGraphOverlay(ctx: Ctx, v: View, topology: TaxiTopology): void {
  ctx.save()
  ctx.lineJoin = 'round'
  for (const e of topology.edges) {
    ctx.strokeStyle = e.straight ? COLORS.graphEdgeFlag : COLORS.graphEdge
    ctx.lineWidth = e.straight ? 2 : 1
    ctx.beginPath()
    trace(ctx, v, e.geom)
    ctx.stroke()
  }
  for (const n of topology.nodes) {
    const [sx, sy] = toScreen(v, n.point[0], n.point[1])
    const junction = n.degree >= 3
    ctx.fillStyle = junction ? COLORS.graphJunction : COLORS.graphNode
    ctx.beginPath()
    ctx.arc(sx, sy, junction ? 3.2 : 2, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Dev sandbox: draw a routing probe — the shortest graph path between two clicked
 *  points (solid), or a dashed red line when the second point has no route. */
export function drawProbe(
  ctx: Ctx,
  v: View,
  probe: { from: Point; to: Point | null; path: Point[] },
): void {
  ctx.save()
  const dot = (p: Point, color: string): void => {
    const [sx, sy] = toScreen(v, p[0], p[1])
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(sx, sy, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  if (probe.path.length >= 2) {
    ctx.strokeStyle = COLORS.probePath
    ctx.lineWidth = 2
    ctx.beginPath()
    trace(ctx, v, probe.path)
    ctx.stroke()
  } else if (probe.to) {
    ctx.strokeStyle = COLORS.probeBad
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 5])
    const [ax, ay] = toScreen(v, probe.from[0], probe.from[1])
    const [bx, by] = toScreen(v, probe.to[0], probe.to[1])
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
    ctx.setLineDash([])
  }
  dot(probe.from, COLORS.probePath)
  if (probe.to) dot(probe.to, probe.path.length >= 2 ? COLORS.probePath : COLORS.probeBad)
  ctx.restore()
}

/** Dev sandbox: a ring at the routing node where a Spawn click would drop an aircraft. */
export function drawSpawnPreview(ctx: Ctx, v: View, at: Point): void {
  const [sx, sy] = toScreen(v, at[0], at[1])
  ctx.save()
  ctx.strokeStyle = COLORS.probePath
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(sx, sy, 7, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}
