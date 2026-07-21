import { describe, it, expect } from 'vitest'
import type { AirportSurface, Point, RunwayLayout, SurfaceFeature, TaxiTopology } from '@anotheratc/sim'
import {
  polylineLength,
  polylineMidpoint,
  distToSeg,
  drawGraphOverlay,
  drawRunwayMarkings,
  nearestTaxiwayRef,
  prepareSurface,
} from './render'
import { COLORS } from './palette'
import { fitView } from './view'

/** Build a minimal surface from taxiway/taxilane polylines for hit-testing. */
function surfaceOf(features: SurfaceFeature[]): AirportSurface {
  return {
    icao: 'TEST',
    name: 'Test',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'synthetic',
    bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
    features,
  }
}

function taxiway(ref: string, points: Point[]): SurfaceFeature {
  return { kind: 'taxiway', points, ref }
}

describe('polylineLength', () => {
  it('sums segment lengths along the polyline', () => {
    // 3-4-5 leg then a unit hop → 5 + 1
    expect(polylineLength([[0, 0], [3, 4], [3, 5]])).toBeCloseTo(6, 9)
  })

  it('is zero for a single point or empty polyline', () => {
    expect(polylineLength([[2, 2]])).toBe(0)
    expect(polylineLength([])).toBe(0)
  })
})

describe('polylineMidpoint', () => {
  it('returns the arc-length midpoint, independent of vertex spacing', () => {
    // Total length 4 along the x-axis; midpoint is x=2 regardless of where vertices fall.
    const uneven = polylineMidpoint([[0, 0], [0.5, 0], [4, 0]])
    expect(uneven).not.toBeNull()
    expect(uneven?.[0]).toBeCloseTo(2, 9)
    expect(uneven?.[1]).toBeCloseTo(0, 9)
  })

  it('interpolates within the segment that straddles the halfway mark', () => {
    // L-shape: right 2 then up 2 (total 4). Half = 2 lands exactly at the corner.
    const mid = polylineMidpoint([[0, 0], [2, 0], [2, 2]])
    expect(mid?.[0]).toBeCloseTo(2, 9)
    expect(mid?.[1]).toBeCloseTo(0, 9)
  })

  it('returns the sole point for a zero-length polyline', () => {
    expect(polylineMidpoint([[1, 7]])).toEqual([1, 7])
  })

  it('returns null when there are no points', () => {
    expect(polylineMidpoint([])).toBeNull()
  })
})

describe('distToSeg', () => {
  it('is the perpendicular distance when the foot lies on the segment', () => {
    // Point (1,2) onto the x-axis segment (0,0)-(4,0) → 2.
    expect(distToSeg(1, 2, 0, 0, 4, 0)).toBeCloseTo(2, 9)
  })

  it('clamps to the nearer endpoint when the projection falls off the segment', () => {
    // Foot would be at x=-3 (before the start), so distance is to (0,0).
    expect(distToSeg(-3, 0, 0, 0, 4, 0)).toBeCloseTo(3, 9)
    // Beyond the end → distance to (4,0).
    expect(distToSeg(9, 0, 0, 0, 4, 0)).toBeCloseTo(5, 9)
  })

  it('handles a degenerate (zero-length) segment as distance to the point', () => {
    expect(distToSeg(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 9)
  })
})

describe('nearestTaxiwayRef', () => {
  const surface = surfaceOf([
    taxiway('A', [[0, 0], [10, 0]]), // long spine along y=0
    taxiway('B', [[5, 0], [5, 4]]), // stub branching north from the spine
  ])

  it('returns the designator of the closest taxiway within range', () => {
    expect(nearestTaxiwayRef(surface, 2, 0.2, 0.5)).toBe('A')
    expect(nearestTaxiwayRef(surface, 5, 3, 0.5)).toBe('B')
  })

  it('returns null when nothing is within maxNm', () => {
    expect(nearestTaxiwayRef(surface, 2, 5, 0.5)).toBeNull()
  })

  it('breaks a near-tie in favor of the longer taxiway (through-route over stub)', () => {
    // At the junction both legs are ~equidistant; the longer spine A must win.
    expect(nearestTaxiwayRef(surface, 5, 0, 0.5)).toBe('A')
  })

  it('ignores features without a ref', () => {
    const unnamed = surfaceOf([{ kind: 'taxiway', points: [[0, 0], [10, 0]] }])
    expect(nearestTaxiwayRef(unnamed, 2, 0, 0.5)).toBeNull()
  })
})

describe('prepareSurface', () => {
  const surface = surfaceOf([
    { kind: 'runway', points: [[-1, 0], [1, 0]], ref: '9/27' },
    { kind: 'taxiway', points: [[0, -0.5], [0, -0.2]], ref: 'A' }, // off the runway, to the south
    { kind: 'apron', points: [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7]], ref: 'RAMP' },
    { kind: 'holding_position', points: [[0, -0.2]] },
    { kind: 'gate', points: [[0, -0.5]], ref: 'G1' },
  ])

  it('sorts features into static draw buckets', () => {
    const prep = prepareSurface(surface)
    expect(prep.taxiways).toHaveLength(1)
    expect(prep.runwayPavement).toHaveLength(1)
    expect(prep.runwayCenterlines).toHaveLength(1)
    expect(prep.holdShort).toEqual([[0, -0.2]])
  })

  it('derives the world-space label anchors once', () => {
    const prep = prepareSurface(surface)
    expect(prep.taxiLabels.map((l) => l.text)).toEqual(['A'])
    expect(prep.stands.map((s) => s.ref)).toContain('G1')
    expect(prep.areaLabels.map((l) => l.text)).toContain('RAMP')
    // 9 sits at the west (min-x) threshold, 27 at the east (max-x) threshold.
    const nine = prep.runwayNumbers.find((r) => r.text === '9')
    const twoSeven = prep.runwayNumbers.find((r) => r.text === '27')
    expect(nine?.at[0]).toBe(-1)
    expect(twoSeven?.at[0]).toBe(1)
  })
})

describe('drawGraphOverlay', () => {
  // A canvas 2D stub that records the strokeStyle in effect at each stroke() call.
  function recordingCtx() {
    const strokes: string[] = []
    let strokeStyle = ''
    const ctx = {
      get strokeStyle() {
        return strokeStyle
      },
      set strokeStyle(v: string) {
        strokeStyle = v
      },
      fillStyle: '',
      lineWidth: 0,
      lineJoin: '',
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      fill() {},
      stroke() {
        strokes.push(strokeStyle)
      },
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes }
  }

  it('strokes flagged straight edges in the flag color and normal edges in the edge color', () => {
    const topology: TaxiTopology = {
      nodes: [
        { key: 'a', point: [0, 0], degree: 3 },
        { key: 'b', point: [1, 0], degree: 1 },
        { key: 'c', point: [0, 1], degree: 1 },
      ],
      edges: [
        { a: 'a', b: 'b', ref: 'STR', geom: [[0, 0], [1, 0]], length: 1, straight: true },
        { a: 'a', b: 'c', ref: 'CRV', geom: [[0, 0], [0, 1]], length: 1, straight: false },
      ],
    }
    const { ctx, strokes } = recordingCtx()
    drawGraphOverlay(ctx, fitView({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 200, 200), topology)
    expect(strokes).toContain(COLORS.graphEdgeFlag)
    expect(strokes).toContain(COLORS.graphEdge)
  })
})

describe('drawRunwayMarkings', () => {
  /** Canvas stub recording where things were drawn, and in what colour. */
  function tracingCtx() {
    const ops: { style: string; pts: [number, number][] }[] = []
    let pending: [number, number][] = []
    let strokeStyle = ''
    let fillStyle = ''
    let dash: number[] = []
    let unbalanced = false
    const stack: { strokeStyle: string; fillStyle: string; lineCap: string; font: string; dash: number[] }[] = []
    const ctx = {
      get strokeStyle() {
        return strokeStyle
      },
      set strokeStyle(v: string) {
        strokeStyle = v
      },
      get fillStyle() {
        return fillStyle
      },
      set fillStyle(v: string) {
        fillStyle = v
      },
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      // A real save/restore stack, so an unbalanced pair (or a style left dirty for the next
      // draw pass in the same frame) is caught rather than silently passing.
      save() {
        stack.push({ strokeStyle, fillStyle, lineCap: ctx.lineCap, font: ctx.font, dash })
      },
      restore() {
        const prev = stack.pop()
        if (!prev) {
          unbalanced = true
          return
        }
        strokeStyle = prev.strokeStyle
        fillStyle = prev.fillStyle
        ctx.lineCap = prev.lineCap
        ctx.font = prev.font
        dash = prev.dash
      },
      translate() {},
      rotate() {},
      setLineDash(d: number[]) {
        dash = d
      },
      beginPath() {
        pending = []
      },
      closePath() {},
      moveTo(x: number, y: number) {
        pending.push([x, y])
      },
      lineTo(x: number, y: number) {
        pending.push([x, y])
      },
      arc() {},
      fillText() {},
      fill() {
        ops.push({ style: fillStyle, pts: [...pending] })
      },
      stroke() {
        ops.push({ style: strokeStyle, pts: [...pending] })
      },
    }
    return {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      ops,
      state: () => ({ depth: stack.length, unbalanced, strokeStyle, fillStyle, dash, lineCap: ctx.lineCap }),
    }
  }

  // Runway along y=0 from x=0 to x=2, with end "A" displaced 0.3 and an EMAS bed beyond it.
  const layout: RunwayLayout = {
    ident: 'A/B',
    widthFt: 200,
    ends: [
      { ident: 'A', pavementEnd: [0, 0], threshold: [0.3, 0], emas: { lengthFt: 315, widthFt: 218 } },
      { ident: 'B', pavementEnd: [2, 0], threshold: [1.8, 0], emas: null },
    ],
  }
  const view = fitView({ minX: -1, minY: -1, maxX: 3, maxY: 1 }, 1600, 800)
  const worldX = (sx: number) => (sx - view.offX) / view.scale

  it('paints the threshold bar at the displaced threshold, not at the end of the pavement', () => {
    const { ctx, ops } = tracingCtx()
    drawRunwayMarkings(ctx, view, layout)
    const bars = ops.filter((o) => o.style === COLORS.runwayThreshold)
    expect(bars).toHaveLength(2)
    const xs = bars.map((b) => worldX(b.pts[0]![0])).sort((p, q) => p - q)
    expect(xs[0]).toBeCloseTo(0.3, 2) // displaced end A — not 0
    expect(xs[1]).toBeCloseTo(1.8, 2) // displaced end B — not 2
  })

  it('draws the EMAS bed outside the pavement, never on the runway', () => {
    const { ctx, ops } = tracingCtx()
    drawRunwayMarkings(ctx, view, layout)
    const bed = ops.find((o) => o.style === COLORS.emasFill)
    expect(bed).toBeDefined()
    // Every corner of the bed lies beyond the pavement end, away from the runway.
    for (const [sx] of bed!.pts) expect(worldX(sx)).toBeLessThanOrEqual(0.0001)
    // …and it is only at the end that has one.
    expect(ops.filter((o) => o.style === COLORS.emasFill)).toHaveLength(1)
  })

  it('leads into the threshold with arrows over the pre-threshold pavement', () => {
    const { ctx, ops } = tracingCtx()
    drawRunwayMarkings(ctx, view, layout)
    const arrows = ops.filter((o) => o.style === COLORS.runwayMarking)
    expect(arrows.length).toBeGreaterThan(0)
    // Every arrow lies on the pre-threshold pavement of one end or the other — never on the
    // landable surface between the two thresholds.
    for (const a of arrows) {
      for (const [sx] of a.pts) {
        const x = worldX(sx)
        const nearA = x > -0.01 && x < 0.32
        const nearB = x > 1.68 && x < 2.01
        expect(nearA || nearB).toBe(true)
      }
    }
  })

  it('leaves the canvas exactly as it found it', () => {
    // Anything left dirty — a butt line cap, a dash pattern, the designator's font — bleeds
    // into every later pass of the same frame (hotspots, approach course, aircraft).
    const { ctx, state } = tracingCtx()
    ctx.strokeStyle = 'sentinel-stroke'
    ctx.fillStyle = 'sentinel-fill'
    ctx.lineCap = 'round'
    ctx.setLineDash([9, 9])
    drawRunwayMarkings(ctx, view, layout)
    const after = state()
    expect(after.unbalanced).toBe(false)
    expect(after.depth).toBe(0) // every save() was matched by a restore()
    expect(after.strokeStyle).toBe('sentinel-stroke')
    expect(after.fillStyle).toBe('sentinel-fill')
    expect(after.lineCap).toBe('round')
    expect(after.dash).toEqual([9, 9])
  })

  it('draws nothing when zoomed too far out to read', () => {
    const { ctx, ops } = tracingCtx()
    drawRunwayMarkings(ctx, fitView({ minX: -500, minY: -500, maxX: 500, maxY: 500 }, 400, 400), layout)
    expect(ops).toHaveLength(0)
  })
})

describe('prepareSurface — stand lines', () => {
  const surface = surfaceOf([
    taxiway('A', [[-1, 0], [1, 0]]),
    { kind: 'gate', ref: '1', points: [[0, 0.1]] },
    { kind: 'gate', ref: '2', points: [[0.5, 0.1]] },
    { kind: 'parking_position', ref: '2', points: [[0.5, 0], [0.5, 0.12]] },
  ])

  it('carries one oriented line per gate, flagged charted or derived', () => {
    const prep = prepareSurface(surface)
    expect(prep.standLines.map((s) => s.ref)).toEqual(['1', '2'])
    const bySource = Object.fromEntries(prep.standLines.map((s) => [s.ref, s.source]))
    // Gate 2 has a painted line in the data; gate 1's is inferred off the taxiway.
    expect(bySource).toEqual({ '1': 'derived', '2': 'charted' })
  })

  it('orders every line taxi-side first so it can be driven in and reversed out', () => {
    for (const s of prepareSurface(surface).standLines) {
      expect(s.entry).toEqual(s.lead[0])
      expect(s.stop).toEqual(s.lead[s.lead.length - 1])
      expect(Math.abs(s.entry[1])).toBeLessThan(Math.abs(s.stop[1])) // entry nearer the taxiway
    }
  })
})
