import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AircraftInit, ServicingConfig } from './sim'
import type { AirportSurface } from '../world/types'

// A gate stand set back from a taxiway; the nearest taxi node (0,0) is the alley to push onto.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.2, minY: -0.2, maxX: 0.6, maxY: 0.2 },
  features: [{ kind: 'taxiway', points: [[0, 0], [0.5, 0]] }],
}

function departure(): AircraftInit {
  return { id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, -0.05]], targetSpeed: 0, intent: 'departure', gate: '1' }
}

// fuel is the long pole (30s); cargo 20s; cabin 10s — all run in parallel.
const servicing: ServicingConfig = {
  services: [
    { kind: 'fuel', sec: 30 },
    { kind: 'cargo', sec: 20 },
    { kind: 'cabin', sec: 10 },
  ],
}

describe('ground servicing → pushback readiness', () => {
  it('refuses pushback until every service completes, counting down the long pole', () => {
    const graph = buildTaxiGraph(surface)
    const sim = createGroundSim([departure()], { graph, servicing })

    // At the gate, servicing in progress → pushback refused, countdown = the long pole (fuel).
    expect(sim.snapshot().aircraft[0]!.serviceSec).toBe(30)
    const early = sim.dispatch({ type: 'pushback', aircraftId: 'a' })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reason).toMatch(/servicing/i)

    // Halfway: cabin/cargo may be done but fuel is not — still refused.
    for (let i = 0; i < 150; i += 1) sim.step(0.1) // 15s
    expect(sim.snapshot().aircraft[0]!.serviceSec).toBeGreaterThan(0)
    expect(sim.dispatch({ type: 'pushback', aircraftId: 'a' }).ok).toBe(false)

    // Past the long pole: all complete → pushback accepted.
    for (let i = 0; i < 160; i += 1) sim.step(0.1) // +16s (31s total)
    expect(sim.snapshot().aircraft[0]!.serviceSec).toBe(0)
    expect(sim.dispatch({ type: 'pushback', aircraftId: 'a' }).ok).toBe(true)
    expect(sim.snapshot().aircraft[0]!.status).toBe('pushback')
  })

  it('exposes per-service progress that drains in parallel', () => {
    const graph = buildTaxiGraph(surface)
    const sim = createGroundSim([departure()], { graph, servicing })
    for (let i = 0; i < 110; i += 1) sim.step(0.1) // 11s

    const a = sim.snapshot().aircraft[0]!
    expect(a.services.find((s) => s.kind === 'cabin')!.remaining).toBe(0) // 10s service done by 11s
    expect(a.services.find((s) => s.kind === 'cargo')!.remaining).toBeGreaterThan(0) // 20s still going
    expect(a.services.find((s) => s.kind === 'fuel')!.remaining).toBeGreaterThan(0) // 30s still going
  })

  it('does not gate pushback when no servicing is configured', () => {
    const graph = buildTaxiGraph(surface)
    const sim = createGroundSim([departure()], { graph }) // no servicing
    expect(sim.snapshot().aircraft[0]!.services).toEqual([])
    expect(sim.snapshot().aircraft[0]!.serviceSec).toBe(0)
    expect(sim.dispatch({ type: 'pushback', aircraftId: 'a' }).ok).toBe(true)
  })

  it('does not service arrivals', () => {
    const graph = buildTaxiGraph(surface)
    const arr: AircraftInit = { id: 'r', callsign: 'ASA1', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'arrival', gate: '1', goalPoint: [0.5, 0] }
    const sim = createGroundSim([arr], { graph, servicing })
    expect(sim.snapshot().aircraft[0]!.services).toEqual([])
    expect(sim.snapshot().aircraft[0]!.serviceSec).toBe(0)
  })
})
