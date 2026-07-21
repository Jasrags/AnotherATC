import { describe, it, expect } from 'vitest'
import { buildKsanGroundGame, KSAN_RUNWAYS } from './ksanGame'
import { createGroundSim } from './sim'
import { buildRunwayExits, chooseExit } from './runwayExits'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'
import {
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
