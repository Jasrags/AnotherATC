import { describe, it, expect } from 'vitest'
import {
  createTerminalSim,
  TURN_RATE_DEG_S,
  type TerminalAircraftInit,
  type TerminalSim,
} from './sim'

// A terminal aircraft inbound, level, straight — the radar-target foundation (docs/atc-tracon.md §3).
const inbound = (over: Partial<TerminalAircraftInit> = {}): TerminalAircraftInit => ({
  id: 'a',
  callsign: 'SWA1',
  type: 'B738',
  wake: 'M',
  position: [0, 0],
  altitudeFt: 10000,
  headingDeg: 90, // due east
  speedKt: 180,
  ...over,
})
const A = (sim: TerminalSim) => sim.snapshot().aircraft.find((x) => x.id === 'a')!
const step = (sim: TerminalSim, seconds: number, dt = 0.1) => {
  for (let i = 0; i < Math.round(seconds / dt); i += 1) sim.step(dt)
}

describe('terminal sim — deterministic airborne kinematics (docs/atc-tracon.md §3)', () => {
  it('flies straight along its heading at its groundspeed', () => {
    const sim = createTerminalSim([inbound()]) // heading 90 (east), 180 kt
    step(sim, 60) // one minute
    const a = A(sim)
    // 180 kt for 1 min = 3 nm, due east (+x); heading and altitude unchanged.
    expect(a.position[0]).toBeCloseTo(3, 2)
    expect(a.position[1]).toBeCloseTo(0, 3)
    expect(a.headingDeg).toBeCloseTo(90, 5)
    expect(a.altitudeFt).toBeCloseTo(10000, 5)
  })

  it('turns toward an assigned heading at the standard rate, shortest way', () => {
    const sim = createTerminalSim([inbound()]) // heading 90
    expect(sim.dispatch({ type: 'vectorHeading', aircraftId: 'a', headingDeg: 180 }).ok).toBe(true)
    step(sim, 10)
    // 3°/s for 10 s = 30° of turn, rightward (90 → 120).
    expect(A(sim).headingDeg).toBeCloseTo(90 + TURN_RATE_DEG_S * 10, 1)
    step(sim, 30) // well past the remaining 60°
    expect(A(sim).headingDeg).toBeCloseTo(180, 1) // reached and held, no overshoot
  })

  it('turns the short way across 0° (10° → 350° goes left, not right)', () => {
    const sim = createTerminalSim([inbound({ headingDeg: 10 })])
    sim.dispatch({ type: 'vectorHeading', aircraftId: 'a', headingDeg: 350 })
    step(sim, 3) // 9° of turn
    // Shortest path is left (decreasing, through 0) — 10 → 1, not 10 → 19.
    expect(A(sim).headingDeg).toBeCloseTo(1, 1)
  })

  it('descends toward an assigned altitude and levels off (no overshoot)', () => {
    // Altitude target is part of the kinematic model even though Slice 1's only command is a vector.
    const sim = createTerminalSim([inbound({ altitudeFt: 10000, targetAltitudeFt: 3000 })])
    const before = A(sim).altitudeFt
    step(sim, 60)
    expect(A(sim).altitudeFt).toBeLessThan(before) // descending
    step(sim, 600) // long enough to arrive
    expect(A(sim).altitudeFt).toBeCloseTo(3000, 1) // level at target, not past it
  })

  it('accelerates/decelerates toward an assigned speed and holds it', () => {
    const sim = createTerminalSim([inbound({ speedKt: 250, targetSpeedKt: 180 })])
    step(sim, 600)
    expect(A(sim).speedKt).toBeCloseTo(180, 1)
  })

  it('refuses a vector for an unknown aircraft', () => {
    const sim = createTerminalSim([inbound()])
    const res = sim.dispatch({ type: 'vectorHeading', aircraftId: 'ghost', headingDeg: 270 })
    expect(res.ok).toBe(false)
  })

  it('normalizes an out-of-range assigned heading (e.g. 450 → 90)', () => {
    const sim = createTerminalSim([inbound({ headingDeg: 90 })])
    sim.dispatch({ type: 'vectorHeading', aircraftId: 'a', headingDeg: 450 })
    step(sim, 5)
    expect(A(sim).headingDeg).toBeCloseTo(90, 5) // 450 ≡ 90, already there
  })

  it('carries a position history trail and is deterministic', () => {
    const mk = () => {
      const sim = createTerminalSim([inbound()])
      sim.dispatch({ type: 'vectorHeading', aircraftId: 'a', headingDeg: 200 })
      step(sim, 120)
      return sim.snapshot()
    }
    const first = mk()
    const second = mk()
    expect(first.aircraft).toEqual(second.aircraft) // deterministic
    expect(first.aircraft[0]!.trail.length).toBeGreaterThan(1) // a trail accrued
  })
})
