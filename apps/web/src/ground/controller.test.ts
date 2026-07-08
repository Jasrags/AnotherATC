import { describe, it, expect } from 'vitest'
import { createGroundController } from './controller'

describe('ground controller bridge', () => {
  it('seeds an initial snapshot with the game aircraft and no selection or draft', () => {
    const c = createGroundController()
    const snap = c.getSnapshot()
    expect(snap.aircraft.map((a) => a.id)).toContain('init0')
    expect(snap.selectedId).toBeNull()
    expect(snap.draft).toBeNull()
    expect(c.selectedId()).toBeNull()
    // parked departures at t=0 owe no wake separation
    expect(snap.aircraft.every((a) => a.wakeHoldSec === 0)).toBe(true)
  })

  it('select sets the selection and reflects it in the snapshot', () => {
    const c = createGroundController()
    c.select('init0')
    expect(c.selectedId()).toBe('init0')
    expect(c.getSnapshot().selectedId).toBe('init0')
  })

  it('selecting a different aircraft discards a route draft bound to the old one', () => {
    const c = createGroundController()
    c.beginRoute('init0')
    expect(c.routeDraft()?.id).toBe('init0')
    c.select('init1') // route mode is bound to its aircraft
    expect(c.routeDraft()).toBeNull()
  })

  it('keeps the draft when re-selecting the same aircraft', () => {
    const c = createGroundController()
    c.beginRoute('init0')
    c.select('init0')
    expect(c.routeDraft()?.id).toBe('init0')
  })

  it('addVia appends taxiways but ignores a consecutive repeat', () => {
    const c = createGroundController()
    c.beginRoute('init0')
    c.addVia('A')
    c.addVia('A') // consecutive repeat — ignored
    c.addVia('B')
    c.addVia('A') // not consecutive — kept
    expect(c.routeDraft()?.via).toEqual(['A', 'B', 'A'])
  })

  it('removeViaAt removes by index and ignores out-of-range indices', () => {
    const c = createGroundController()
    c.beginRoute('init0')
    c.addVia('A')
    c.addVia('B')
    c.addVia('C')
    c.removeViaAt(1) // drop 'B'
    expect(c.routeDraft()?.via).toEqual(['A', 'C'])
    c.removeViaAt(5) // out of range — no-op
    c.removeViaAt(-1) // out of range — no-op
    expect(c.routeDraft()?.via).toEqual(['A', 'C'])
  })

  it('clearRoute discards the draft', () => {
    const c = createGroundController()
    c.beginRoute('init0')
    c.clearRoute()
    expect(c.routeDraft()).toBeNull()
    expect(c.getSnapshot().draft).toBeNull()
  })

  it('notifies subscribers only when the strip signature actually changes', () => {
    const c = createGroundController()
    let calls = 0
    c.subscribe(() => {
      calls += 1
    })
    c.select('init0') // selection changed → fires
    expect(calls).toBe(1)
    c.select('init0') // no change → no fire
    expect(calls).toBe(1)
    c.select('init1') // changed again → fires
    expect(calls).toBe(2)
  })

  it('unsubscribe stops further notifications', () => {
    const c = createGroundController()
    let calls = 0
    const off = c.subscribe(() => {
      calls += 1
    })
    c.select('init0')
    off()
    c.select('init1')
    expect(calls).toBe(1)
  })

  it('has no notice initially and surfaces a refusal reason after a rejected command', () => {
    const c = createGroundController()
    expect(c.notice()).toBeNull()
    c.dispatch({ type: 'hold', aircraftId: 'ghost' }) // unknown aircraft → refused
    expect(c.notice()).toMatch(/unknown aircraft/i)
  })

  it('leaves no notice after an accepted command', () => {
    const c = createGroundController()
    c.dispatch({ type: 'clearance', aircraftId: 'init0' }) // departure, uncleared → accepted
    expect(c.notice()).toBeNull()
  })
})

// KSAN spans roughly x ∈ [-0.85, 0.75] nm; these are safely inside the field.
const KSAN_WEST = -0.6
const KSAN_EAST = 0.6

describe('ground controller — dev sandbox', () => {
  it('starts empty in dev mode (no seeded aircraft)', () => {
    expect(createGroundController({ dev: true }).getSnapshot().aircraft).toHaveLength(0)
    expect(createGroundController().dev).toBe(false)
    expect(createGroundController({ dev: true }).dev).toBe(true)
  })

  it('spawnAt places a test aircraft (snapped to the network) and selects it', () => {
    const c = createGroundController({ dev: true })
    c.spawnAt([0, 0]) // arbitrary point → snaps to nearest routing node
    const snap = c.getSnapshot()
    expect(snap.aircraft).toHaveLength(1)
    expect(c.selectedId()).toBe(snap.aircraft[0]!.id)
    expect(snap.aircraft[0]!.callsign).toMatch(/^DEV\d\d$/)
  })

  it('spawns onto a gate stand when clicking near one (gates are not routing nodes)', () => {
    const c = createGroundController({ dev: true })
    c.spawnAt([-0.711, 0.041]) // gate 41's stand point
    const ac = c.sim.snapshot().aircraft[0]!
    expect(ac.gate).toBe('41')
    // placed at the stand (~0 away), not snapped to the nearest taxiway node (~0.06 nm off)
    expect(Math.hypot(ac.x - -0.711, ac.y - 0.041)).toBeLessThan(2e-3)
  })

  it('removeSelected and clearAll empty the surface', () => {
    const c = createGroundController({ dev: true })
    c.spawnAt([0, 0])
    c.spawnAt([0.1, 0])
    c.removeSelected() // removes the most recently placed (selected) one
    expect(c.getSnapshot().aircraft).toHaveLength(1)
    c.clearAll()
    expect(c.getSnapshot().aircraft).toHaveLength(0)
    expect(c.selectedId()).toBeNull()
  })

  it('probe routes between two clicked points and reports length + taxiways', () => {
    const c = createGroundController({ dev: true })
    expect(c.probe()).toBeNull()
    c.probeClick([KSAN_WEST, 0]) // origin
    expect(c.probe()?.to).toBeNull() // awaiting the second click
    c.probeClick([KSAN_EAST, 0]) // destination across the field
    const pr = c.probe()!
    expect(pr.to).not.toBeNull()
    expect(pr.path.length).toBeGreaterThan(2)
    expect(pr.lengthNm).toBeGreaterThan(0)
    c.clearProbe()
    expect(c.probe()).toBeNull()
  })
})
