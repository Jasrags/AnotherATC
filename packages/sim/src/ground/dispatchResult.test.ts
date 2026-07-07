import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'

function dep(id: string): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'departure' }
}

describe('dispatch result feedback', () => {
  it('refuses an unknown aircraft with a reason', () => {
    const sim = createGroundSim([dep('a')])
    const r = sim.dispatch({ type: 'hold', aircraftId: 'ghost' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown aircraft/i)
  })

  it('accepts a valid hold', () => {
    const sim = createGroundSim([dep('a')])
    expect(sim.dispatch({ type: 'hold', aircraftId: 'a' })).toEqual({ ok: true })
  })

  it('refuses give-way to an unknown or self target', () => {
    const sim = createGroundSim([dep('a')])
    const unknown = sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'nobody' })
    expect(unknown.ok).toBe(false)
    const self = sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'a' })
    expect(self.ok).toBe(false)
  })

  it('refuses pushback for an arrival', () => {
    const arr: AircraftInit = { id: 'r', callsign: 'R', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'arrival' }
    const sim = createGroundSim([arr])
    const r = sim.dispatch({ type: 'pushback', aircraftId: 'r' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/departure/i)
  })

  it('refuses crossRunway when not holding short', () => {
    const sim = createGroundSim([dep('a')])
    const r = sim.dispatch({ type: 'crossRunway', aircraftId: 'a' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/holding short/i)
  })

  it('issues clearance once, then refuses a duplicate', () => {
    const sim = createGroundSim([dep('a')])
    expect(sim.dispatch({ type: 'clearance', aircraftId: 'a' })).toEqual({ ok: true })
    const again = sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toMatch(/already/i)
  })

  it('refuses a taxi command when there is no taxi graph', () => {
    const sim = createGroundSim([dep('a')])
    const r = sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 1] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/route|graph/i)
  })
})
