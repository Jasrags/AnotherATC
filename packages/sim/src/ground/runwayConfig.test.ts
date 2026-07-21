import { describe, it, expect } from 'vitest'
import { buildKsanGroundGame, KSAN_RUNWAYS, KSAN_RUNWAY_LAYOUT } from './ksanGame'
import { createGroundSim } from './sim'
import { buildRunwayExits, chooseExit } from './runwayExits'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'
import {
  displacedNm,
  finalFix,
  glideAltitudeFt,
  landingDistanceNm,
  pavementAfterThresholdNm,
  takeoffRunNm,
  FT_PER_NM,
} from './runway'

const ft = (nm: number) => nm * FT_PER_NM

describe('KSAN runway configuration', () => {
  it('carries the FAA declared distances (docs/SAN/runway-9-27.md)', () => {
    expect(ft(takeoffRunNm(KSAN_RUNWAYS['27']))).toBeCloseTo(9401, -2)
    expect(ft(takeoffRunNm(KSAN_RUNWAYS['09']))).toBeCloseTo(8280, -2)
    expect(ft(landingDistanceNm(KSAN_RUNWAYS['27']))).toBeCloseTo(7591, -2)
    expect(ft(landingDistanceNm(KSAN_RUNWAYS['09']))).toBeCloseTo(7280, -2)
  })

  it('declared distances are not just the distance between two points', () => {
    // 27 declares the whole pavement, so its LDA does match the geometry…
    const r27 = KSAN_RUNWAYS['27']
    expect(ft(pavementAfterThresholdNm(r27)) - r27.ldaFt).toBeLessThan(100)
    // …but 09 declares ~1,100 ft less than the pavement between its threshold and the far end.
    const r09 = KSAN_RUNWAYS['09']
    expect(ft(pavementAfterThresholdNm(r09)) - r09.ldaFt).toBeGreaterThan(900)
  })

  it('the landing threshold is not the end of the pavement', () => {
    const r27 = KSAN_RUNWAYS['27']
    const displaced = ft(Math.hypot(
      r27.threshold[0] - r27.departureStart[0],
      r27.threshold[1] - r27.departureStart[1],
    ))
    expect(displaced).toBeCloseTo(1806, -2) // published 1,810 ft
    // …and 09's is a different, smaller displacement — they are not symmetric.
    const r09 = KSAN_RUNWAYS['09']
    const d09 = ft(Math.hypot(
      r09.threshold[0] - r09.departureStart[0],
      r09.threshold[1] - r09.departureStart[1],
    ))
    expect(d09).toBeCloseTo(998, -2) // published 1,000 ft
    expect(Math.abs(displaced - d09)).toBeGreaterThan(700)
  })

  it('the two configurations are exact opposites of each other', () => {
    expect(KSAN_RUNWAYS['27'].farEnd).toEqual(KSAN_RUNWAYS['09'].departureStart)
    expect(KSAN_RUNWAYS['09'].farEnd).toEqual(KSAN_RUNWAYS['27'].departureStart)
  })

  it('uses the published glide path per end, not one hard-coded angle', () => {
    expect(KSAN_RUNWAYS['27'].glidePathDeg).toBe(3.5) // steep, LOC-only approach
    expect(KSAN_RUNWAYS['09'].glidePathDeg).toBe(3.3)
    // A 4 nm final on 27 is meaningfully higher than on 09 because of it.
    expect(glideAltitudeFt(3.5, 4) - glideAltitudeFt(3.3, 4)).toBeGreaterThan(80)
  })

  it('puts the final on the approach side of the threshold', () => {
    for (const ident of ['09', '27'] as const) {
      const r = KSAN_RUNWAYS[ident]
      const fix = finalFix(r, 4)
      // The fix is 4 nm out, and further from the far end than the threshold is.
      expect(Math.hypot(fix[0] - r.threshold[0], fix[1] - r.threshold[1])).toBeCloseTo(4, 6)
      const distFixToFar = Math.hypot(fix[0] - r.farEnd[0], fix[1] - r.farEnd[1])
      const distThrToFar = Math.hypot(r.threshold[0] - r.farEnd[0], r.threshold[1] - r.farEnd[1])
      expect(distFixToFar).toBeGreaterThan(distThrToFar)
    }
  })
})

describe('single runway: arrivals and departures share a direction', () => {
  const bearing = (from: readonly [number, number], to: readonly [number, number]) =>
    (((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI) + 360) % 360
  const delta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

  it('a departure rolls the same way an arrival lands — the game used to run them head-on', () => {
    for (const config of ['09', '27'] as const) {
      const game = buildKsanGroundGame(1, config)
      const r = game.runway
      // Landing: fix → threshold. Departing: departure end → far end.
      const landing = bearing(game.spawn.approach.fix, game.spawn.approach.threshold)
      const departing = bearing(game.spawn.departureTarget, r.farEnd)
      expect(delta(landing, departing)).toBeLessThan(5)
    }
  })

  it('27 is the default configuration and lands westbound over the city', () => {
    const game = buildKsanGroundGame(1)
    expect(game.runway.ident).toBe('27')
    // True alignment 286° for 27 (FAA); the chart's 275° is magnetic.
    const landing = bearing(game.spawn.approach.fix, game.spawn.approach.threshold)
    expect(delta(landing, 286)).toBeLessThan(3)
    // …and the final is east of the field, over downtown.
    expect(game.spawn.approach.fix[0]).toBeGreaterThan(game.runway.threshold[0])
  })

  it('09 lands eastbound from over the water', () => {
    const game = buildKsanGroundGame(1, '09')
    const landing = bearing(game.spawn.approach.fix, game.spawn.approach.threshold)
    expect(delta(landing, 106)).toBeLessThan(3) // FAA true alignment for 09
    expect(game.spawn.approach.fix[0]).toBeLessThan(game.runway.threshold[0])
  })
})

describe('exits follow the configuration', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const topo = buildTaxiGraph(KSAN_SURFACE).topology()

  it('are measured from the displaced threshold, so the usable half is the LDA half', () => {
    const r = KSAN_RUNWAYS['27']
    const exits = buildRunwayExits(topo, guard, r.threshold, r.farEnd)
    expect(exits.length).toBeGreaterThan(0)
    const usable = pavementAfterThresholdNm(r)
    for (const e of exits) {
      expect(e.distanceNm).toBeGreaterThanOrEqual(usable / 2 - 1e-9)
      expect(e.distanceNm).toBeLessThanOrEqual(usable)
    }
  })

  it('a landing on 27 turns off on the west half of the field', () => {
    const r = KSAN_RUNWAYS['27']
    const chosen = chooseExit(buildRunwayExits(topo, guard, r.threshold, r.farEnd), 140, 0)
    expect(chosen).not.toBeNull()
    // Rolling west from a threshold at x≈0.46, the turnoff has to be further west than that.
    expect(chosen!.point[0]).toBeLessThan(r.threshold[0])
  })

  it('the two configurations use different turnoffs', () => {
    const on27 = buildRunwayExits(topo, guard, KSAN_RUNWAYS['27'].threshold, KSAN_RUNWAYS['27'].farEnd)
    const on09 = buildRunwayExits(topo, guard, KSAN_RUNWAYS['09'].threshold, KSAN_RUNWAYS['09'].farEnd)
    expect(on27.map((e) => e.ref)).not.toEqual(on09.map((e) => e.ref))
  })
})

describe('the sim honours the configuration', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  it('an arrival descends on the published glide path and touches down at the threshold', () => {
    const game = buildKsanGroundGame(1, '27')
    const r = game.runway
    const sim = createGroundSim(
      [
        {
          id: 'a',
          callsign: 'AAL1',
          type: 'B738',
          wake: 'M',
          path: [game.spawn.approach.fix, game.spawn.approach.threshold],
          targetSpeed: 140,
          airborne: true,
          intent: 'arrival',
          goalPoint: game.spawn.gates[0]!.point,
          gate: game.spawn.gates[0]!.ref,
        },
      ],
      { guard, graph, runway: r },
    )
    const start = sim.snapshot().aircraft[0]!
    // 4 nm on a 3.5° path ≈ 1,487 ft, not the 1,250 ft a flat 3° assumption would give.
    expect(start.altitude).toBeCloseTo(glideAltitudeFt(3.5, 4), -1)

    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    let touchdown: { x: number; y: number } | null = null
    for (let i = 0; i < 3000; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === 'a')
      if (!a) break
      if (!touchdown && a.status === 'rollout') touchdown = { x: a.x, y: a.y }
      if (a.vacated) break
    }
    expect(touchdown).not.toBeNull()
    const off = Math.hypot(touchdown!.x - r.threshold[0], touchdown!.y - r.threshold[1])
    expect(ft(off)).toBeLessThan(200) // touched down at the displaced threshold, not the pavement end
  })
})

describe('EMAS and the pre-threshold pavement', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  it('sits beyond the west pavement end, clear of the runway', () => {
    const west = KSAN_RUNWAY_LAYOUT.ends.find((e) => e.ident === '09')!
    const east = KSAN_RUNWAY_LAYOUT.ends.find((e) => e.ident === '27')!
    // "EMAS ... LCTD AT DER 27" — the departure end of runway 27 is the *west* end.
    expect(west.emas).not.toBeNull()
    expect(east.emas).toBeNull()
    expect(west.emas!.lengthFt).toBe(315)
    expect(west.emas!.widthFt).toBe(218)
    // The bed is outside the pavement: the west end is further west than everything else.
    expect(west.pavementEnd[0]).toBeLessThan(east.pavementEnd[0])
  })

  it('records both displaced thresholds in the painted layout', () => {
    for (const end of KSAN_RUNWAY_LAYOUT.ends) {
      expect(ft(displacedNm(end))).toBeGreaterThan(900)
    }
    const byIdent = Object.fromEntries(KSAN_RUNWAY_LAYOUT.ends.map((e) => [e.ident, e]))
    expect(ft(displacedNm(byIdent['09']!))).toBeCloseTo(998, -2)
    expect(ft(displacedNm(byIdent['27']!))).toBeCloseTo(1806, -2)
  })

  it('a landing on 27 rolls out without running off the pavement into the bed', () => {
    const game = buildKsanGroundGame(1, '27')
    const r = game.runway
    const sim = createGroundSim(
      [
        {
          id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M',
          path: [game.spawn.approach.fix, game.spawn.approach.threshold],
          targetSpeed: 140, airborne: true, intent: 'arrival',
          goalPoint: game.spawn.gates[0]!.point, gate: game.spawn.gates[0]!.ref,
        },
      ],
      { guard, graph, runway: r },
    )
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    let westmost = Infinity
    for (let i = 0; i < 4000; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === 'a')
      if (!a) break
      westmost = Math.min(westmost, a.x)
      if (a.vacated) break
    }
    // Rolling west, it must stop short of the west pavement end — beyond that is the EMAS bed.
    expect(westmost).toBeGreaterThan(r.farEnd[0])
  })
})

describe('a departure needs runway ahead of it', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  // Unit vector along the runway, and its perpendicular, so fixtures can be placed relative to
  // either end without hand-computing coordinates.
  const w = KSAN_RUNWAYS['09'].departureStart
  const e = KSAN_RUNWAYS['27'].departureStart
  const len = Math.hypot(e[0] - w[0], e[1] - w[1])
  const ux = (e[0] - w[0]) / len
  const uy = (e[1] - w[1]) / len

  /** A departure holding short of `end`, handed to Tower, with its goal on the runway. */
  const holdingShortAt = (end: readonly [number, number], config: '09' | '27') => {
    const off = 0.08
    const near: [number, number] = [end[0] + uy * off, end[1] - ux * off]
    const across: [number, number] = [end[0] - uy * off, end[1] + ux * off]
    const game = buildKsanGroundGame(1, config)
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'DEV01', type: 'B738', wake: 'M',
          path: [near, [end[0], end[1]], across],
          targetSpeed: 15, intent: 'departure', goalPoint: [end[0], end[1]],
        },
      ],
      { guard, graph, runway: game.runway },
    )
    expect(sim.snapshot().aircraft[0]!.holdingForTakeoff).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    return sim
  }

  it('refuses a takeoff from the wrong end of the runway in use', () => {
    // RWY 27 is active (rolls west), but this aircraft is at the west end. Cleared, it used to
    // be given a "takeoff roll" to a point a few feet away and drive straight off the pavement.
    const sim = holdingShortAt(w, '27')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'insufficient runway remaining — RWY 27 is in use',
    })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'insufficient runway remaining — RWY 27 is in use',
    })
  })

  it('accepts the same aircraft once that end is the one in use', () => {
    const sim = holdingShortAt(w, '09')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
  })

  it('an aircraft at the in-use end lines up and gets airborne', () => {
    const sim = holdingShortAt(e, '27')
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 400; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.status).toBe('lineUpWait')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 900; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })
})

describe('switching the airport configuration', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  it('moves the arrival final and the departure end together', () => {
    const game = buildKsanGroundGame(1, '27')
    const sim = createGroundSim([], { guard, graph, runway: game.runway })
    expect(sim.runway()!.ident).toBe('27')
    const on27 = sim.approach()!
    sim.setRunway(KSAN_RUNWAYS['09'])
    const on09 = sim.approach()!
    expect(sim.runway()!.ident).toBe('09')
    // The final flips to the other side of the field, and the threshold with it.
    expect(on27.fix[0]).toBeGreaterThan(on27.threshold[0])
    expect(on09.fix[0]).toBeLessThan(on09.threshold[0])
    expect(on09.threshold).not.toEqual(on27.threshold)
  })

  it('lets an aircraft take off from the end that just became active', () => {
    const game = buildKsanGroundGame(1, '27')
    const off = 0.08
    const wEnd = KSAN_RUNWAYS['09'].departureStart
    const eEnd = KSAN_RUNWAYS['27'].departureStart
    const l = Math.hypot(eEnd[0] - wEnd[0], eEnd[1] - wEnd[1])
    const ux = (eEnd[0] - wEnd[0]) / l
    const uy = (eEnd[1] - wEnd[1]) / l
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'DEV01', type: 'B738', wake: 'M',
          path: [
            [wEnd[0] + uy * off, wEnd[1] - ux * off],
            [wEnd[0], wEnd[1]],
            [wEnd[0] - uy * off, wEnd[1] + ux * off],
          ],
          targetSpeed: 15, intent: 'departure', goalPoint: [wEnd[0], wEnd[1]],
        },
      ],
      { guard, graph, runway: game.runway },
    )
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' }).ok).toBe(false)
    sim.setRunway(KSAN_RUNWAYS['09'])
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
  })
})
