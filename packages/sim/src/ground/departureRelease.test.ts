import { describe, it, expect } from 'vitest'
import { createGroundSim, type AircraftInit, type ReleaseConfig } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { ActiveRunway } from './runway'
import type { AirportSurface } from '../world/types'

// Two independent parallel runways, 1 nm apart — far enough that they never share pavement, so the
// release metering can be tested both same-runway (queued) and cross-runway (independent).
// docs/atc-departure-release.md.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Release Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.5, minY: -0.5, maxX: 3, maxY: 1.5 },
  features: [
    { kind: 'runway', ref: 'A', points: [[0, 0], [3, 0]] },
    { kind: 'runway', ref: 'B', points: [[0, 1], [3, 1]] },
  ],
}
const guard = buildRunwayGuard(surface)
const rwy = (ident: string, y: number): ActiveRunway => ({
  ident,
  threshold: [0, y],
  departureStart: [0, y],
  farEnd: [3, y],
  toraFt: 10000,
  ldaFt: 10000,
  glidePathDeg: 3,
  pattern: 'left',
})
const RWY_A = rwy('09A', 0) // physical id 'A'
const RWY_B = rwy('09B', 1) // physical id 'B'
const RELEASES: ReleaseConfig = { coordSec: 10, intervalSec: 60, voidSec: 90 }

/** A departure holding short of a runway end, ready to be cleared. */
const departure = (id: string, r: ActiveRunway): AircraftInit => ({
  id,
  callsign: id.toUpperCase(),
  type: 'B738',
  wake: 'M',
  path: [[-0.05, r.departureStart[1]], r.departureStart],
  targetSpeed: 5,
  intent: 'departure',
  goalPoint: r.departureStart,
})

const A = (sim: ReturnType<typeof createGroundSim>, id: string) => sim.snapshot().aircraft.find((a) => a.id === id)!
const step = (sim: ReturnType<typeof createGroundSim>, n: number) => {
  for (let i = 0; i < n; i += 1) sim.step(0.1)
}
/** Bring a departure to holding short, deliver its clearance (which flags the release requirement),
 *  and hand it to Tower — the state from which Tower calls for release. */
const readyForRelease = (runways: ActiveRunway[], ...inits: AircraftInit[]) => {
  const sim = createGroundSim(inits, { guard, runways, releases: RELEASES, runwaysInteract: () => false })
  for (let i = 0; i < 2000 && !inits.every((x) => A(sim, x.id).holdShort); i += 1) sim.step(0.1)
  for (const x of inits) {
    expect(A(sim, x.id).holdShort).toBe(true)
    expect(sim.dispatch({ type: 'clearance', aircraftId: x.id }).ok).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: x.id }).ok).toBe(true)
  }
  return sim
}

describe('departure releases — TRACON coordination (docs/atc-departure-release.md)', () => {
  it('a release field flags every departure at clearance', () => {
    const sim = createGroundSim([departure('d', RWY_A)], { guard, runways: [RWY_A], releases: RELEASES })
    step(sim, 500) // reach hold short
    expect(A(sim, 'd').release).toBe('none') // not yet cleared
    sim.dispatch({ type: 'clearance', aircraftId: 'd' })
    expect(A(sim, 'd').release).toBe('required')
  })

  it('no release needed at a field without a release config', () => {
    const sim = createGroundSim([departure('d', RWY_A)], { guard, runways: [RWY_A] })
    step(sim, 500)
    sim.dispatch({ type: 'clearance', aircraftId: 'd' })
    expect(A(sim, 'd').release).toBe('none')
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' }).ok).toBe(true) // never gated
  })

  it('takeoff is refused until Tower calls for release and TRACON grants it', () => {
    const sim = readyForRelease([RWY_A], departure('d', RWY_A))
    // Not yet requested → "call for release".
    let res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/call for release/i)

    // Request it → pending, and still refused ("hold for release") until the coordination delay.
    expect(sim.dispatch({ type: 'requestRelease', aircraftId: 'd' }).ok).toBe(true)
    expect(A(sim, 'd').release).toBe('requested')
    res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/hold for release/i)

    // TRACON grants it after coordSec; now the takeoff is allowed.
    step(sim, RELEASES.coordSec * 10 + 5)
    expect(A(sim, 'd').release).toBe('released')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' }).ok).toBe(true)
  })

  it('refuses a release request when none is required or one is already held', () => {
    const sim = readyForRelease([RWY_A], departure('d', RWY_A))
    expect(sim.dispatch({ type: 'requestRelease', aircraftId: 'd' }).ok).toBe(true)
    step(sim, RELEASES.coordSec * 10 + 5)
    expect(A(sim, 'd').release).toBe('released')
    expect(sim.dispatch({ type: 'requestRelease', aircraftId: 'd' }).ok).toBe(false) // already released
  })

  it('meters same-runway releases one at a time (intervalSec apart)', () => {
    const sim = readyForRelease([RWY_A], departure('d1', RWY_A), departure('d2', RWY_A))
    const t0 = sim.snapshot().time
    sim.dispatch({ type: 'requestRelease', aircraftId: 'd1' })
    sim.dispatch({ type: 'requestRelease', aircraftId: 'd2' })
    // First is granted after the coordination delay.
    for (let i = 0; i < 2000 && A(sim, 'd1').release !== 'released'; i += 1) sim.step(0.1)
    const grant1 = sim.snapshot().time
    expect(A(sim, 'd2').release).toBe('requested') // second still held — metered behind the first
    // Second is granted only after the runway's interval has elapsed since the first.
    for (let i = 0; i < 2000 && A(sim, 'd2').release !== 'released'; i += 1) sim.step(0.1)
    const grant2 = sim.snapshot().time
    expect(grant1 - t0).toBeGreaterThanOrEqual(RELEASES.coordSec - 0.5)
    expect(grant2 - grant1).toBeGreaterThanOrEqual(RELEASES.intervalSec - 0.5)
  })

  it('releases independent runways independently — no cross-runway metering', () => {
    const sim = readyForRelease([RWY_A, RWY_B], departure('a', RWY_A), departure('b', RWY_B))
    sim.dispatch({ type: 'requestRelease', aircraftId: 'a' })
    sim.dispatch({ type: 'requestRelease', aircraftId: 'b' })
    // Both are granted after only the coordination delay — neither waits on the other's runway.
    step(sim, RELEASES.coordSec * 10 + 5)
    expect(A(sim, 'a').release).toBe('released')
    expect(A(sim, 'b').release).toBe('released')
  })

  it('spends the release at takeoff — a departure rolling past its void window is not re-voided', () => {
    // Regression: once the roll is committed the release is spent (needsRelease cleared), so the
    // void-lapse sweep must not fire a spurious "release void" at the now-airborne departure even
    // if its roll+climbout outlasts voidSec. docs/atc-departure-release.md §5. Clearing the takeoff
    // late in the void window (but while still valid) guarantees the roll straddles the void time.
    const sim = readyForRelease([RWY_A], departure('d', RWY_A))
    sim.dispatch({ type: 'requestRelease', aircraftId: 'd' })
    for (let i = 0; i < 2000 && A(sim, 'd').release !== 'released'; i += 1) sim.step(0.1)
    // Hold short with a valid release almost to the edge of the void window, then launch.
    step(sim, RELEASES.voidSec * 10 - 100) // ~10 s of validity left
    expect(A(sim, 'd').release).toBe('released')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' }).ok).toBe(true)
    expect(A(sim, 'd').release).toBe('none') // spent at the roll, not left dangling
    // Roll it out well past the void time. The release was spent, so no "release void" is issued.
    step(sim, RELEASES.voidSec * 10 + 50)
    expect(sim.snapshot().comms.filter((t) => /release void/i.test(t.text))).toHaveLength(0)
  })

  it('lapses a release whose void window runs out, back to needing a fresh request', () => {
    const sim = readyForRelease([RWY_A], departure('d', RWY_A))
    sim.dispatch({ type: 'requestRelease', aircraftId: 'd' })
    for (let i = 0; i < 2000 && A(sim, 'd').release !== 'released'; i += 1) sim.step(0.1)
    expect(A(sim, 'd').release).toBe('released')
    // Never launched — let the void window run out.
    step(sim, RELEASES.voidSec * 10 + 20)
    expect(A(sim, 'd').release).toBe('required') // must call for release again
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' }).ok).toBe(false)
  })
})
