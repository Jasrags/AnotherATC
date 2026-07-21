import { describe, it, expect } from 'vitest'
import { fitPoints, fitView, toScreen, toWorld, zoomAt, pan, reframe, MIN_SCALE, MAX_SCALE } from './view'
import type { Bounds } from '@anotheratc/sim'

const bounds: Bounds = { minX: -1, minY: -0.5, maxX: 1, maxY: 0.5 }

describe('view transforms', () => {
  it('toWorld inverts toScreen', () => {
    const v = fitView(bounds, 800, 600)
    const [sx, sy] = toScreen(v, 0.3, -0.2)
    const [wx, wy] = toWorld(v, sx, sy)
    expect(wx).toBeCloseTo(0.3, 9)
    expect(wy).toBeCloseTo(-0.2, 9)
  })

  it('fitView centers the bounds midpoint on screen', () => {
    const v = fitView(bounds, 800, 600)
    const [sx, sy] = toScreen(v, 0, 0) // bounds midpoint is (0, 0)
    expect(sx).toBeCloseTo(400, 6)
    expect(sy).toBeCloseTo(300, 6)
  })

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const v = fitView(bounds, 800, 600)
    const cursor: [number, number] = [520, 210]
    const before = toWorld(v, cursor[0], cursor[1])
    const zoomed = zoomAt(v, 1.8, cursor[0], cursor[1])
    const after = toWorld(zoomed, cursor[0], cursor[1])
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
  })

  it('clamps zoom-in at MAX_SCALE (no runaway)', () => {
    let v = fitView(bounds, 800, 600)
    for (let i = 0; i < 100; i += 1) v = zoomAt(v, 2, 400, 300)
    expect(v.scale).toBe(MAX_SCALE)
  })

  it('clamps zoom-out at MIN_SCALE (never collapses toward zero)', () => {
    let v = fitView(bounds, 800, 600)
    for (let i = 0; i < 100; i += 1) v = zoomAt(v, 0.5, 400, 300)
    expect(v.scale).toBe(MIN_SCALE)
  })

  it('keeps the cursor point fixed even when the zoom is clamped', () => {
    // Drive scale to the ceiling, then a further zoom-in must not drift the view.
    let v = fitView(bounds, 800, 600)
    for (let i = 0; i < 100; i += 1) v = zoomAt(v, 2, 400, 300)
    const cursor: [number, number] = [610, 250]
    const before = toWorld(v, cursor[0], cursor[1])
    const after = toWorld(zoomAt(v, 2, cursor[0], cursor[1]), cursor[0], cursor[1])
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
  })

  it('reframe preserves zoom and keeps the centered world point centered (WEB-2)', () => {
    // A controller who has panned/zoomed must not get refit-to-bounds on a window resize.
    const zoomed = zoomAt(fitView(bounds, 800, 600), 3, 500, 200)
    const worldAtOldCenter = toWorld(zoomed, 400, 300)
    const rf = reframe(zoomed, 800, 600, 1000, 500)
    expect(rf.scale).toBe(zoomed.scale) // zoom preserved, not reset to fit
    const [cx, cy] = toScreen(rf, worldAtOldCenter[0], worldAtOldCenter[1])
    expect(cx).toBeCloseTo(500, 6) // 1000 / 2
    expect(cy).toBeCloseTo(250, 6) // 500 / 2
  })

  it('pan shifts screen position by the given delta', () => {
    const v = fitView(bounds, 800, 600)
    const [sx, sy] = toScreen(v, 0.2, 0.1)
    const [px, py] = toScreen(pan(v, 25, -10), 0.2, 0.1)
    expect(px - sx).toBeCloseTo(25, 9)
    expect(py - sy).toBeCloseTo(-10, 9)
  })

  it('fitPoints frames off-field traffic that the surface bounds exclude', () => {
    // An arrival 4 nm west of the field is far outside the airport bounds: fitView alone
    // leaves it off-screen, which is exactly the visibility problem this exists to solve.
    const inbound: [number, number] = [-5, 0]
    const fitted = fitView(bounds, 800, 600)
    const [offX] = toScreen(fitted, inbound[0], inbound[1])
    expect(offX).toBeLessThan(0) // off the left edge

    const framed = fitPoints(bounds, [inbound], 800, 600)
    const [sx, sy] = toScreen(framed, inbound[0], inbound[1])
    expect(sx).toBeGreaterThanOrEqual(0)
    expect(sx).toBeLessThanOrEqual(800)
    expect(sy).toBeGreaterThanOrEqual(0)
    expect(sy).toBeLessThanOrEqual(600)
    expect(framed.scale).toBeLessThan(fitted.scale) // zoomed out to take it in
  })

  it('fitPoints with no extra points is just fitView', () => {
    expect(fitPoints(bounds, [], 800, 600)).toEqual(fitView(bounds, 800, 600))
  })

  it('fitPoints keeps the airport in frame even when traffic is far off one side', () => {
    const framed = fitPoints(bounds, [[-5, 0]], 800, 600)
    for (const corner of [
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.maxY],
    ] as const) {
      const [sx, sy] = toScreen(framed, corner[0], corner[1])
      expect(sx).toBeGreaterThanOrEqual(0)
      expect(sx).toBeLessThanOrEqual(800)
      expect(sy).toBeGreaterThanOrEqual(0)
      expect(sy).toBeLessThanOrEqual(600)
    }
  })
})
