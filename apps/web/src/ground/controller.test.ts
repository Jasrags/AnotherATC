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
