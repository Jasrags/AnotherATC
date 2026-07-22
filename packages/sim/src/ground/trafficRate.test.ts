import { describe, it, expect } from 'vitest'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'

const graph = buildTaxiGraph(KSAN_SURFACE)
const guard = buildRunwayGuard(KSAN_SURFACE)

/** A KSAN sim with the real spawner running, at the given traffic rate. */
function running(rate?: number, seed = 5) {
  const game = createAirportGame(KSAN, seed)
  const sim = createGroundSim([], { graph, guard, spawn: game.spawn, runway: game.runway })
  if (rate !== undefined) sim.setTrafficRate(rate)
  return sim
}

/** Every callsign the spawner produced over `seconds` of simulated time. */
function spawnedOver(sim: ReturnType<typeof running>, seconds: number): Set<string> {
  const seen = new Set<string>()
  // Half-second steps: these runs are minutes to an hour of simulated time, and nothing here
  // turns on sub-second physics — only on how many aircraft the spawner produced.
  for (let i = 0; i < seconds * 2; i += 1) {
    sim.step(0.5)
    for (const a of sim.snapshot().aircraft) seen.add(a.callsign)
  }
  return seen
}

describe('traffic rate', () => {
  it('defaults to the field\'s configured rate', () => {
    expect(running().trafficRate()).toBe(1)
  })

  it('spawns less traffic at a lower rate than at the default', () => {
    const light = spawnedOver(running(0.4), 600).size
    const normal = spawnedOver(running(), 600).size
    expect(light).toBeGreaterThan(0)
    expect(light).toBeLessThan(normal)
  })

  it('spawns more traffic at a higher rate than at the default', () => {
    const heavy = spawnedOver(running(2), 600).size
    const normal = spawnedOver(running(), 600).size
    expect(heavy).toBeGreaterThan(normal)
  })

  it('stops generating traffic entirely at rate 0', () => {
    expect(spawnedOver(running(0), 900).size).toBe(0)
  })

  it('holds fewer aircraft on the surface at a lower rate — the cap scales too', () => {
    // Interval alone would only delay the fill: a long enough session still reaches the
    // configured cap. Turning traffic down has to mean a smaller field, not a slower one.
    const light = running(0.25)
    spawnedOver(light, 3600)
    expect(light.snapshot().aircraft.length).toBeLessThan(KSAN.traffic.maxAircraft)
  })

  it('takes effect immediately rather than after the interval already pending', () => {
    const sim = running()
    // Most of the way through a spawn interval at the default rate…
    sim.step(KSAN.traffic.intervalSec - 1)
    expect(sim.snapshot().aircraft.length).toBe(0)
    sim.setTrafficRate(0)
    sim.step(2)
    expect(sim.snapshot().aircraft.length).toBe(0)
  })

  it('refuses a rate that is not a finite share', () => {
    expect(() => running(-1)).toThrow(/traffic rate/i)
    expect(() => running(Number.NaN)).toThrow(/traffic rate/i)
  })

  it('is a no-op on a sim with no spawner at all', () => {
    const sim = createGroundSim([], { graph, guard })
    sim.setTrafficRate(0.5)
    expect(sim.trafficRate()).toBe(0.5)
    expect(spawnedOver(sim, 300).size).toBe(0)
  })
})
