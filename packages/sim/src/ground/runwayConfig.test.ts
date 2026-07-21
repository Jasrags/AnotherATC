import { describe, it, expect } from 'vitest'
import { buildKsanGroundGame, KSAN_RUNWAYS, KSAN_RUNWAY_LAYOUT } from './ksanGame'
import { createGroundSim } from './sim'
import { buildRunwayExits, chooseExit } from './runwayExits'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'
import type { Point } from '../world/types'
import {
  displacedNm,
  finalFix,
  glideAltitudeFt,
  landingDistanceNm,
  landingEnd,
  takeoffEnd,
  pavementAfterThresholdNm,
  reciprocalIdent,
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
    const exits = buildRunwayExits(topo, guard, r.threshold, landingEnd(r))
    expect(exits.length).toBeGreaterThan(0)
    const lda = landingDistanceNm(r)
    for (const e of exits) {
      expect(e.distanceNm).toBeGreaterThanOrEqual(lda / 2 - 1e-9)
      expect(e.distanceNm).toBeLessThanOrEqual(lda)
    }
  })

  it('stop at the declared landing distance, not at the end of the pavement', () => {
    // On 09 the two differ by ~1,100 ft: pavement continues past where the LDA runs out.
    const r = KSAN_RUNWAYS['09']
    expect(ft(pavementAfterThresholdNm(r)) - r.ldaFt).toBeGreaterThan(900)
    const declared = buildRunwayExits(topo, guard, r.threshold, landingEnd(r))
    const wholePavement = buildRunwayExits(topo, guard, r.threshold, r.farEnd)
    for (const e of declared) expect(ft(e.distanceNm)).toBeLessThanOrEqual(r.ldaFt + 1)
    // The looser bound really would have admitted turnoffs the declared distance does not.
    expect(wholePavement.length).toBeGreaterThanOrEqual(declared.length)
  })

  it('a takeoff roll ends at the declared TORA, not at the end of the pavement', () => {
    const r09 = KSAN_RUNWAYS['09']
    const rollEnd = takeoffEnd(r09)
    const toPavementEnd = ft(Math.hypot(r09.farEnd[0] - r09.departureStart[0], r09.farEnd[1] - r09.departureStart[1]))
    const toRollEnd = ft(Math.hypot(rollEnd[0] - r09.departureStart[0], rollEnd[1] - r09.departureStart[1]))
    expect(toRollEnd).toBeCloseTo(8280, -2) // the declared TORA
    expect(toPavementEnd - toRollEnd).toBeGreaterThan(1000) // pavement it may not use
    // 27 declares the lot, so there its roll does reach the pavement end.
    const r27 = KSAN_RUNWAYS['27']
    const end27 = takeoffEnd(r27)
    expect(ft(Math.hypot(end27[0] - r27.farEnd[0], end27[1] - r27.farEnd[1]))).toBeLessThan(50)
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
    // The reason has to say *why*: this is a configuration problem, not a busy runway.
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'RWY 09 is not in use — RWY 27 is the active runway',
    })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'RWY 09 is not in use — RWY 27 is the active runway',
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

describe('departures use the pavement before the threshold', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  it('a 27 departure gets the whole TORA, not the shorter LDA', () => {
    // The point of a displaced threshold: 1,810 ft of pavement a landing may not touch down on
    // is still the departure's to roll on. Sending departures to the *threshold* instead of the
    // pavement end would quietly cost them that.
    const game = buildKsanGroundGame(1, '27')
    const r = game.runway
    expect(game.spawn.departureTarget).toEqual(r.departureStart)
    const runFromDepartureEnd = ft(Math.hypot(
      r.farEnd[0] - r.departureStart[0],
      r.farEnd[1] - r.departureStart[1],
    ))
    const runFromThreshold = ft(Math.hypot(r.farEnd[0] - r.threshold[0], r.farEnd[1] - r.threshold[1]))
    expect(runFromDepartureEnd).toBeCloseTo(9378, -2) // ≈ the declared TORA of 9,401
    expect(runFromDepartureEnd - runFromThreshold).toBeGreaterThan(1700) // the displaced portion
  })

  it('lines up at the departure end and rolls the full length', () => {
    const game = buildKsanGroundGame(1, '27')
    const r = game.runway
    const off = 0.08
    const l = Math.hypot(r.farEnd[0] - r.departureStart[0], r.farEnd[1] - r.departureStart[1])
    const ux = (r.farEnd[0] - r.departureStart[0]) / l
    const uy = (r.farEnd[1] - r.departureStart[1]) / l
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'AAL9', type: 'B738', wake: 'M',
          path: [
            [r.departureStart[0] + uy * off, r.departureStart[1] - ux * off],
            [r.departureStart[0], r.departureStart[1]],
            [r.departureStart[0] - uy * off, r.departureStart[1] + ux * off],
          ],
          targetSpeed: 15, intent: 'departure', goalPoint: [r.departureStart[0], r.departureStart[1]],
        },
      ],
      { guard, graph, runway: r },
    )
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    for (let i = 0; i < 400; i += 1) sim.step(0.1)
    const lined = sim.snapshot().aircraft[0]!
    // Lined up behind the landing threshold — on the pavement only a departure may use.
    const toThreshold = ft(Math.hypot(lined.x - r.threshold[0], lined.y - r.threshold[1]))
    expect(toThreshold).toBeGreaterThan(1200)
    expect(lined.status).toBe('lineUpWait')
  })
})

describe('lining up follows the connector onto the runway', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  it('drives the taxiway curve and finishes pointing down the runway', () => {
    // Holding short at the east end, where B1 curves onto RWY 27. Lining up used to path
    // straight at the nearest centerline point, so the aircraft slid sideways onto the runway
    // and sat there crabbed across it.
    const game = buildKsanGroundGame(1, '27')
    const r = game.runway
    const off = 0.08
    const l = Math.hypot(r.farEnd[0] - r.departureStart[0], r.farEnd[1] - r.departureStart[1])
    const ux = (r.farEnd[0] - r.departureStart[0]) / l
    const uy = (r.farEnd[1] - r.departureStart[1]) / l
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'DEV01', type: 'B738', wake: 'M',
          path: [
            [r.departureStart[0] + uy * off, r.departureStart[1] - ux * off],
            [r.departureStart[0], r.departureStart[1]],
            [r.departureStart[0] - uy * off, r.departureStart[1] + ux * off],
          ],
          targetSpeed: 15, intent: 'departure', goalPoint: [r.departureStart[0], r.departureStart[1]],
        },
      ],
      { guard, graph, runway: r },
    )
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 600; i += 1) sim.step(0.1)

    const d = sim.snapshot().aircraft[0]!
    expect(d.status).toBe('lineUpWait')
    // Aligned with the takeoff direction, not across it.
    const takeoff = (((Math.atan2(ux, uy) * 180) / Math.PI) + 360) % 360
    expect(Math.abs(((d.heading - takeoff + 540) % 360) - 180)).toBeLessThan(20)
    expect(d.onRunway).toBe(true)
  })

  it('uses the connector geometry rather than one straight cut at the centerline', () => {
    const game = buildKsanGroundGame(1, '27')
    const r = game.runway
    const off = 0.08
    const l = Math.hypot(r.farEnd[0] - r.departureStart[0], r.farEnd[1] - r.departureStart[1])
    const ux = (r.farEnd[0] - r.departureStart[0]) / l
    const uy = (r.farEnd[1] - r.departureStart[1]) / l
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'DEV01', type: 'B738', wake: 'M',
          path: [
            [r.departureStart[0] + uy * off, r.departureStart[1] - ux * off],
            [r.departureStart[0], r.departureStart[1]],
            [r.departureStart[0] - uy * off, r.departureStart[1] + ux * off],
          ],
          targetSpeed: 15, intent: 'departure', goalPoint: [r.departureStart[0], r.departureStart[1]],
        },
      ],
      { guard, graph, runway: r },
    )
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    const route = sim.routeOf('d')

    // A straight cut onto the centerline is 2–3 points. Following the connector is many more:
    // the taxi clearance's held portion is only a chord, so the curve has to come from the graph.
    expect(route.length).toBeGreaterThan(6)
    // …and no doubling back at the runway edge, which is what going on to the perpendicular
    // projection after the route had already reached the centerline used to produce.
    const brg = (a: Point, b: Point) => (((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI) + 360) % 360
    for (let i = 2; i < route.length; i += 1) {
      const turn = Math.abs(((brg(route[i - 2]!, route[i - 1]!) - brg(route[i - 1]!, route[i]!) + 540) % 360) - 180)
      expect(turn).toBeLessThan(120) // a reversal would be ~155°
    }
  })
})

describe('runway-change cascade', () => {
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const graph = buildTaxiGraph(KSAN_SURFACE)

  const withArrivalOnFinal = (config: '09' | '27') => {
    const game = buildKsanGroundGame(1, config)
    const sim = createGroundSim(
      [
        {
          id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M',
          path: [game.spawn.approach.fix, game.spawn.approach.threshold],
          targetSpeed: 140, airborne: true, intent: 'arrival',
          goalPoint: game.spawn.gates[0]!.point, gate: game.spawn.gates[0]!.ref,
        },
      ],
      { guard, graph, runway: game.runway },
    )
    return sim
  }

  it('sends everyone still on final around onto the new approach', () => {
    const sim = withArrivalOnFinal('27')
    for (let i = 0; i < 300; i += 1) sim.step(0.1) // established, well down the final
    const before = sim.snapshot().aircraft[0]!
    expect(before.finalNm).toBeLessThan(4)

    expect(sim.setRunway(KSAN_RUNWAYS['09'])).toEqual({ ok: true })
    const after = sim.snapshot().aircraft[0]!
    expect(after.status).toBe('onFinal') // went around, not landed
    expect(after.finalNm).toBeGreaterThan(3.9) // re-established at the new fix
    // …and on the *other* side of the field, on 09's approach.
    expect(after.x).toBeLessThan(KSAN_RUNWAYS['09'].threshold[0])
    // The new final is flown at 09's glide path, so it starts lower than 27's.
    expect(after.altitude).toBeLessThan(glideAltitudeFt(3.5, 4))
    expect(after.altitude).toBeCloseTo(glideAltitudeFt(3.3, 4), -1)
  })

  it('a landing clearance does not survive the change', () => {
    const sim = withArrivalOnFinal('27')
    for (let i = 0; i < 300; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    expect(sim.snapshot().aircraft[0]!.status).toBe('landing')
    sim.setRunway(KSAN_RUNWAYS['09'])
    expect(sim.snapshot().aircraft[0]!.status).toBe('onFinal') // must be cleared again
  })

  it('is refused while traffic is committed to the runway in use', () => {
    const sim = withArrivalOnFinal('27')
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    // Fly it inside short final, where it owns the runway.
    for (let i = 0; i < 2000 && !sim.snapshot().aircraft[0]!.onShortFinal; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.onShortFinal).toBe(true)
    const res = sim.setRunway(KSAN_RUNWAYS['09'])
    expect(res.ok).toBe(false)
    expect(sim.runway()!.ident).toBe('27') // unchanged
  })

  it('refuses a change to the runway already in use', () => {
    const sim = withArrivalOnFinal('27')
    expect(sim.setRunway(KSAN_RUNWAYS['27'])).toEqual({ ok: false, reason: 'RWY 27 already in use' })
  })

  it('retargets a departure that has not rolled to the new departure end', () => {
    const game = buildKsanGroundGame(1, '27')
    const gate = game.spawn.gates[0]!
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'UAL2', type: 'B738', wake: 'M',
          path: [gate.point], targetSpeed: 0, intent: 'departure',
          gate: gate.ref, goalPoint: game.runway.departureStart,
        },
      ],
      { guard, graph, runway: game.runway },
    )
    expect(sim.setRunway(KSAN_RUNWAYS['09'])).toEqual({ ok: true })
    // Its clearance was to the east end; the departure end is now the west one.
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'd' })
    const route = sim.routeOf('d')
    const end = route[route.length - 1]!
    expect(Math.hypot(end[0] - KSAN_RUNWAYS['09'].departureStart[0], end[1] - KSAN_RUNWAYS['09'].departureStart[1]))
      .toBeLessThan(0.2)
  })
})

describe('reciprocalIdent', () => {
  it('pairs the two ends of a runway', () => {
    expect(reciprocalIdent('09')).toBe('27')
    expect(reciprocalIdent('27')).toBe('09')
    expect(reciprocalIdent('36')).toBe('18')
    expect(reciprocalIdent('18')).toBe('36')
    expect(reciprocalIdent('01')).toBe('19')
  })

  it('keeps a parallel-runway suffix', () => {
    expect(reciprocalIdent('09L')).toBe('27L')
  })
})
