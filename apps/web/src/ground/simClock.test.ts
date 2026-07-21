import { describe, expect, it } from 'vitest'
import { FIXED_DT, tick } from './simClock'

/** One 60 fps frame. */
const FRAME = 1 / 60

describe('tick', () => {
  it('runs whole fixed steps and carries the remainder', () => {
    const a = tick(0, FRAME, 1)
    expect(a.steps).toBe(0) // 16.7 ms is less than one 50 ms step
    expect(a.acc).toBeCloseTo(FRAME, 9)

    // Three frames add up to one step, with the rest carried.
    const b = tick(a.acc, FRAME, 1)
    const c = tick(b.acc, FRAME, 1)
    expect(a.steps + b.steps + c.steps).toBe(1)
    expect(c.acc).toBeCloseTo(3 * FRAME - FIXED_DT, 9)
  })

  it('scales simulated time by the multiplier', () => {
    // Well inside the background clamp, so only the multiplier is in play.
    expect(tick(0, 0.2, 1).steps).toBe(4)
    expect(tick(0, 0.2, 2).steps).toBe(8)
    expect(tick(0, 0.05, 4).steps).toBe(tick(0, 0.2, 1).steps)
  })

  it('does not lose a step to floating-point drift', () => {
    // FIXED_DT is not exact in binary; subtracting it twenty times from 1.0 lands a hair below
    // zero and silently drops a step, which is a slow clock rather than an obvious bug.
    expect(tick(0, 0.25, 4).steps).toBe(20)
  })

  it('paused runs nothing, and does not bank time while it is stopped', () => {
    const paused = tick(0, 1, 0)
    expect(paused.steps).toBe(0)
    expect(paused.acc).toBe(0)
    // Ten paused seconds must not make the next running frame jump.
    let acc = 0
    for (let i = 0; i < 600; i += 1) acc = tick(acc, FRAME, 0).acc
    expect(tick(acc, FRAME, 1).steps).toBe(0)
  })

  it('clamps real elapsed time *before* the multiplier, so refocusing never fast-forwards', () => {
    // A minute in the background, then one frame. The clamp is on real time, so 4x is bounded
    // by 4 x the clamp — not by 4 x the minute.
    expect(tick(0, 60, 1).steps).toBe(5) // 0.25 s of catch-up, not 60
    expect(tick(0, 60, 4).steps).toBe(20) // 4x that, not 4x the minute
    // …and the same wall-clock gap yields the same bounded catch-up at 1x as any longer gap.
    expect(tick(0, 60, 1).steps).toBe(tick(0, 5, 1).steps)
  })

  it('drops the backlog at the step cap instead of carrying it into later frames', () => {
    // Carrying it would make the frames *after* a stall run long too — one hitch becoming a
    // lasting speed-up rather than a single skipped moment. Unreachable at the offered speeds
    // (0.25 s clamped x 4 is 20 steps), so this pins the guard itself.
    const capped = tick(0, 60, 100)
    expect(capped.steps).toBe(30)
    expect(capped.acc).toBe(0)
  })

  it('ignores a negative or zero frame time', () => {
    expect(tick(0, -1, 1)).toEqual({ steps: 0, acc: 0 })
    expect(tick(0, 0, 1)).toEqual({ steps: 0, acc: 0 })
  })
})
