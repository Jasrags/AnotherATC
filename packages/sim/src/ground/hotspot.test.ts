import { describe, it, expect } from 'vitest'
import { hotspotAt, busyHotspots, HOTSPOT_CONFLICT_FACTOR } from './hotspot'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import type { Hotspot } from '../world/types'

const HS: Hotspot[] = [
  { id: 'HS1', label: 'HS 1', point: [0, 0], radiusNm: 0.05 },
  { id: 'HS2', label: 'HS 2', point: [1, 0], radiusNm: 0.05 },
]

describe('hotspotAt', () => {
  it('names the spot a point is inside, and nothing outside them all', () => {
    expect(hotspotAt([0, 0], HS)).toBe('HS1')
    expect(hotspotAt([0.04, 0], HS)).toBe('HS1')
    expect(hotspotAt([1.01, 0.01], HS)).toBe('HS2')
    expect(hotspotAt([0.5, 0], HS)).toBeNull()
  })

  it('takes the nearest centre where two overlap, not the first charted', () => {
    // Otherwise the answer would depend on the order the field's diagram happened to list them.
    const overlapping: Hotspot[] = [
      { id: 'FAR', label: 'far', point: [0, 0], radiusNm: 0.5 },
      { id: 'NEAR', label: 'near', point: [0.4, 0], radiusNm: 0.5 },
    ]
    expect(hotspotAt([0.39, 0], overlapping)).toBe('NEAR')
    expect(hotspotAt([0.01, 0], overlapping)).toBe('FAR')
  })

  it('is null when the field charts none', () => {
    expect(hotspotAt([0, 0], [])).toBeNull()
  })
})

describe('busyHotspots', () => {
  it('lights a spot only once a second aircraft is in it', () => {
    expect(busyHotspots(['HS1'], HS)).toEqual([])
    expect(busyHotspots(['HS1', 'HS1'], HS)).toEqual(['HS1'])
    expect(busyHotspots(['HS1', null, 'HS1', 'HS2'], HS)).toEqual(['HS1'])
    expect(busyHotspots(['HS1', 'HS1', 'HS2', 'HS2'], HS)).toEqual(['HS1', 'HS2'])
  })

  it('reports them in charted order, not arrival order', () => {
    expect(busyHotspots(['HS2', 'HS2', 'HS1', 'HS1'], HS)).toEqual(['HS1', 'HS2'])
  })
})

// ── Through the sim ────────────────────────────────────────────────────────────

/** Two aircraft holding station `apart` nm from each other, centred on `at`. */
function pair(at: readonly [number, number], apart: number): AircraftInit[] {
  const mk = (id: string, y: number): AircraftInit => ({
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[at[0], y]],
    targetSpeed: 0,
    intent: 'departure',
  })
  return [mk('a', at[1] - apart / 2), mk('b', at[1] + apart / 2)]
}

const conflicted = (sim: ReturnType<typeof createGroundSim>): boolean =>
  sim.snapshot().aircraft.every((a) => a.conflict)

describe('a hot spot makes the sim watch harder', () => {
  // Comfortably outside the open-pavement conflict distance, comfortably inside the hot-spot one.
  const APART = 0.03

  it('calls traffic converging inside a hot spot that would be ignored on open pavement', () => {
    const inside = createGroundSim(pair([0, 0], APART), { hotspots: HS })
    inside.step(0.1)
    expect(conflicted(inside)).toBe(true)

    // The identical pair, the identical distance, somewhere the diagram says nothing about.
    const outside = createGroundSim(pair([0.5, 0], APART), { hotspots: HS })
    outside.step(0.1)
    expect(conflicted(outside)).toBe(false)
  })

  it('changes nothing for a field that charts no hot spots', () => {
    const sim = createGroundSim(pair([0, 0], APART), {})
    sim.step(0.1)
    expect(conflicted(sim)).toBe(false)
  })

  it('still calls a genuine nose-to-nose conflict outside a hot spot', () => {
    const sim = createGroundSim(pair([0.5, 0], 0.01), { hotspots: HS })
    sim.step(0.1)
    expect(conflicted(sim)).toBe(true)
  })

  it('needs both aircraft in the same spot, not one in each', () => {
    const a: AircraftInit = { id: 'a', callsign: 'a', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }
    const b: AircraftInit = { id: 'b', callsign: 'b', type: 'B738', wake: 'M', path: [[1, 0]], targetSpeed: 0 }
    const sim = createGroundSim([a, b], { hotspots: HS })
    sim.step(0.1)
    expect(sim.snapshot().aircraft.some((x) => x.conflict)).toBe(false)
  })

  it('publishes which spot each aircraft is in, and which are busy', () => {
    const sim = createGroundSim(pair([0, 0], APART), { hotspots: HS })
    sim.step(0.1)
    expect(sim.snapshot().aircraft.map((a) => a.hotspot)).toEqual(['HS1', 'HS1'])
    expect(sim.snapshot().busyHotspots).toEqual(['HS1'])
  })

  it('does not call one aircraft alone in a hot spot busy', () => {
    const lone: AircraftInit = { id: 'a', callsign: 'a', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }
    const sim = createGroundSim([lone], { hotspots: HS })
    sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.hotspot).toBe('HS1')
    expect(sim.snapshot().busyHotspots).toEqual([])
  })

  it('warns about three times earlier than open pavement', () => {
    // Pins the ratio the constant states, so tuning one without the other is a failing test.
    expect(HOTSPOT_CONFLICT_FACTOR).toBe(3)
    const justInside = createGroundSim(pair([0, 0], 0.015 * HOTSPOT_CONFLICT_FACTOR - 0.002), { hotspots: HS })
    justInside.step(0.1)
    expect(conflicted(justInside)).toBe(true)
    const justOutside = createGroundSim(pair([0, 0], 0.015 * HOTSPOT_CONFLICT_FACTOR + 0.002), { hotspots: HS })
    justOutside.step(0.1)
    expect(conflicted(justOutside)).toBe(false)
  })
})
