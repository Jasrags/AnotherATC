import { describe, it, expect } from 'vitest'
import { buildStands } from '@anotheratc/sim'
import { createGroundController } from './controller'
import type { Airport, AirportSurface, Point, Rng } from '@anotheratc/sim'
import { visibleComms } from './CommsLog'

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

  it('setPosition switches the active position and notifies subscribers', () => {
    const c = createGroundController()
    expect(c.position()).toBe('ground')
    let calls = 0
    c.subscribe(() => {
      calls += 1
    })
    c.setPosition('tower')
    expect(c.position()).toBe('tower')
    expect(c.getSnapshot().position).toBe('tower')
    expect(calls).toBe(1)
  })

  it('a refused contact-tower does not switch to the Tower position', () => {
    const c = createGroundController()
    c.dispatch({ type: 'contactTower', aircraftId: 'init0' }) // parked at gate → refused
    expect(c.notice()).toMatch(/holding short/i)
    expect(c.position()).toBe('ground')
  })

  it('a successful contact-tower hands off: switches to Tower and announces it', () => {
    const c = createGroundController()
    const step = (n: number) => {
      for (let i = 0; i < n; i += 1) c.sim.step(0.1)
    }
    const ac = () => c.sim.snapshot().aircraft.find((a) => a.id === 'init0')
    c.sim.dispatch({ type: 'clearance', aircraftId: 'init0' })
    step(500) // let ground servicing (fuel ~45s) finish so pushback unlocks
    expect(c.sim.dispatch({ type: 'pushback', aircraftId: 'init0' }).ok).toBe(true)
    step(600) // ease off the stand to the alley
    c.sim.dispatch({ type: 'taxiToGoal', aircraftId: 'init0' }) // taxi to the departure runway
    for (let i = 0; i < 9000 && !ac()?.holdShort; i += 1) c.sim.step(0.1)
    expect(ac()?.holdShort).toBe(true)
    expect(ac()?.holdingForTakeoff).toBe(true) // a takeoff hold, not a crossing

    expect(c.position()).toBe('ground')
    c.dispatch({ type: 'contactTower', aircraftId: 'init0' }) // hand off via the controller
    expect(c.position()).toBe('tower') // auto-followed the aircraft to Tower
    expect(c.notice()).toMatch(/tower/i)
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
    c.spawnAt([-0.711, 0.041]) // gate 41's label node
    const ac = c.sim.snapshot().aircraft[0]!
    expect(ac.gate).toBe('41')

    // It parks on the stand's nose-stop mark and faces the way the lead-in points — NOT on the
    // gate label node, which sits a plane's length further into the terminal. Placing it there
    // left the aircraft off the paint, so its pushback began by sliding sideways onto the line.
    const stand = buildStands(c.airport.surface).find((s) => s.ref === '41')!
    expect(Math.hypot(ac.x - stand.stop[0], ac.y - stand.stop[1])).toBeLessThan(2e-3)
    expect(ac.heading).toBeCloseTo(stand.headingDeg, 0)
    // …and that mark is a real distance from the label node, which is the point of the fix.
    expect(Math.hypot(ac.x - -0.711, ac.y - 0.041)).toBeGreaterThan(2e-3)
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

  it('remove(id) deletes a specific aircraft, not just the selected one (click-to-delete)', () => {
    const c = createGroundController({ dev: true })
    c.spawnAt([0, 0])
    const first = c.selectedId()!
    c.spawnAt([0.1, 0]) // this one is now selected
    const second = c.selectedId()!

    // Remove the *unselected* one directly — the selection stays put.
    c.remove(first)
    expect(c.getSnapshot().aircraft.map((a) => a.id)).toEqual([second])
    expect(c.selectedId()).toBe(second)

    // Removing the selected one clears the selection.
    c.remove(second)
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

describe('dev sandbox', () => {
  it('spawns a test arrival on the final of the runway actually in use', () => {
    const controller = createGroundController({ dev: true })
    controller.setRunway('09')
    controller.spawnArrival()
    const a = controller.getSnapshot().aircraft.find((x) => x.callsign.startsWith('DEV'))
    expect(a).toBeDefined()
    // 09 is flown from the west, so its final fix is west of the threshold. Spawning on the
    // startup configuration's approach instead would put it on the wrong side of the field.
    const route = controller.routeOf(a!.id)
    expect(route.length).toBeGreaterThan(0)
    expect(route[route.length - 1]![0]).toBeGreaterThan(route[0]![0]) // tracking eastbound
  })

  it('clearing the sandbox also drops a probe left on the surface', () => {
    const controller = createGroundController({ dev: true })
    controller.probeClick([0, 0])
    controller.probeClick([0.2, -0.2])
    expect(controller.probe()).not.toBeNull()
    controller.clearAll()
    expect(controller.probe()).toBeNull()
  })
})

describe('the controller runs whatever airport it is given', () => {
  // A minimal second field, defined here and nowhere else — if the web layer still had KSAN
  // baked into it, none of this would take.
  const surface: AirportSurface = {
    icao: 'KTW2',
    name: 'Twofield',
    ref: { lat: 40, lon: -100, elevationFt: 500 },
    units: 'nm',
    source: 'synthetic',
    bounds: { minX: -0.6, minY: -0.2, maxX: 0.6, maxY: 2.2 },
    features: [
      { kind: 'runway', ref: '18/36', points: [[0, 0], [0, 2]] },
      { kind: 'taxiway', ref: 'A', points: [[0.3, 0], [0.3, 1], [0.3, 2]] },
      { kind: 'taxiway', ref: 'A1', points: [[0.3, 0], [0.02, 0]] },
      { kind: 'taxiway', ref: 'A2', points: [[0.3, 2], [0.02, 2]] },
      { kind: 'gate', ref: 'G1', points: [[0.5, 1]] },
    ],
  }
  const runway = (ident: string, from: [number, number], to: [number, number]) => ({
    ident,
    threshold: from,
    departureStart: from,
    farEnd: to,
    toraFt: 12152,
    ldaFt: 12152,
    glidePathDeg: 3,
    pattern: 'left' as const,
  })
  const KTW2: Airport = {
    icao: 'KTW2',
    name: 'TWOFIELD',
    surface,
    runways: [runway('36', [0, 0], [0, 2]), runway('18', [0, 2], [0, 0])],
    defaultRunway: '36',
    layout: {
      ident: '18/36',
      widthFt: 150,
      ends: [
        { ident: '36', pavementEnd: [0, 0], threshold: [0, 0], emas: null },
        { ident: '18', pavementEnd: [0, 2], threshold: [0, 2], emas: null },
      ],
    },
    fleets: [
      {
        kind: 'airline',
        weight: 1,
        gates: [{ ref: 'G1', point: [0.5, 1] as Point }],
        identity: (rng: Rng) => ({ callsign: `TW${rng.int(10, 99)}`, type: 'E75L', wake: 'M' as const }),
      },
    ],
    servicing: { services: [{ kind: 'fuel', sec: 10 }] },
    comms: { ground: '121.7', tower: '119.1', atis: '127.4' },
    traffic: { intervalSec: 15, maxAircraft: 3, initialDepartures: 1 },
  }

  it('adopts the field identity, comms, runways and stands', () => {
    const c = createGroundController({ airport: KTW2 })
    expect(c.airport.icao).toBe('KTW2')
    expect(c.airport.comms.tower).toBe('119.1')
    expect(c.runwayIdents()).toEqual(['36', '18'])
    expect(c.getSnapshot().activeRunway).toBe('36')
    expect(c.destinations.map((d) => d.label)).toEqual(['RWY 36', 'RWY 18'])
    expect(c.getSnapshot().aircraft).toHaveLength(1) // its own initialDepartures
    expect(c.getSnapshot().aircraft[0]!.callsign.startsWith('TW')).toBe(true)
  })

  it('switches between that field own configurations', () => {
    const c = createGroundController({ airport: KTW2 })
    c.setRunway('18')
    expect(c.getSnapshot().activeRunway).toBe('18')
  })

  it('derives that field runway intersections, not another one', () => {
    const c = createGroundController({ airport: KTW2 })
    expect(c.holdShortSpots().map((s) => s.label)).toEqual(['RWY @ A1', 'RWY @ A2'])
  })
})

describe('communications log through the bridge', () => {
  it('publishes the transcript and wakes subscribers when something is said', () => {
    const c = createGroundController()
    expect(c.getSnapshot().comms).toHaveLength(0)

    let renders = 0
    const unsubscribe = c.subscribe(() => {
      renders += 1
    })
    c.dispatch({ type: 'clearance', aircraftId: 'init0' })

    const comms = c.getSnapshot().comms
    expect(comms).toHaveLength(2)
    expect(comms[0]!.from).toBe('controller')
    expect(comms[1]!.from).toBe('pilot')
    expect(renders).toBeGreaterThan(0)

    // A refused command changes nothing — no line, and nothing to re-render for.
    const before = renders
    c.dispatch({ type: 'clearedForTakeoff', aircraftId: 'init0' })
    expect(c.getSnapshot().comms).toHaveLength(2)
    expect(renders).toBe(before)
    unsubscribe()
  })

  it('the transcript follows the aircraft onto the tower frequency', () => {
    const c = createGroundController()
    const id = 'init0'
    c.dispatch({ type: 'clearance', aircraftId: id })
    for (let i = 0; i < 1200; i += 1) c.sim.step(0.1) // ground servicing
    c.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 600; i += 1) c.sim.step(0.1)
    c.dispatch({ type: 'taxiToGoal', aircraftId: id })
    const at = () => c.sim.snapshot().aircraft.find((a) => a.id === id)!
    for (let i = 0; i < 20000 && !at().holdShort; i += 1) c.sim.step(0.1)
    expect(at().holdShort).toBe(true)
    c.dispatch({ type: 'contactTower', aircraftId: id })
    c.publish()

    const comms = c.getSnapshot().comms
    expect(comms.filter((t) => t.position === 'ground').length).toBeGreaterThan(4)
    // Everything after the handoff is Tower's conversation.
    expect(comms.at(-1)!.position).toBe('tower')
    expect(visibleComms(comms, 'tower').every((t) => t.position === 'tower')).toBe(true)
    expect(visibleComms(comms, 'ground').some((t) => t.text.includes('contact tower'))).toBe(true)
  })
})

describe('arrival destination stand', () => {
  it('flags an inbound arrival whose gate is already occupied, and clears once it parks', () => {
    const c = createGroundController()
    // A seeded departure sits on a stand; send an arrival to that same gate.
    const occupied = c.getSnapshot().aircraft.find((a) => a.gate !== null)!.gate!
    const stand = buildStands(c.airport.surface).find((s) => s.ref === occupied)!
    const ap = c.approach()
    c.sim.add({
      id: 'arr',
      callsign: 'ARR',
      type: 'B738',
      wake: 'M',
      path: [ap.fix, ap.threshold],
      targetSpeed: 140,
      airborne: true,
      intent: 'arrival',
      gate: occupied,
      goalPoint: stand.stop,
    })
    c.publish()

    const item = () => c.getSnapshot().aircraft.find((a) => a.id === 'arr')!
    // Inbound to a taken gate — the conflict is visible before it arrives.
    expect(item().destStandOccupied).toBe(true)

    // An arrival to a free gate does not flag.
    const taken = new Set(c.getSnapshot().aircraft.map((a) => a.gate))
    const free = buildStands(c.airport.surface).find((s) => s.source === 'charted' && !taken.has(s.ref))!
    c.sim.add({
      id: 'arr2',
      callsign: 'ARR2',
      type: 'B738',
      wake: 'M',
      path: [ap.fix, ap.threshold],
      targetSpeed: 140,
      airborne: true,
      intent: 'arrival',
      gate: free.ref,
      goalPoint: free.stop,
    })
    c.publish()
    expect(c.getSnapshot().aircraft.find((a) => a.id === 'arr2')!.destStandOccupied).toBe(false)
  })
})

describe('focus request', () => {
  it('is empty until asked for, and is consumed once taken', () => {
    const c = createGroundController()
    expect(c.takeFocus()).toBeNull()

    c.focusOn('init0')
    expect(c.takeFocus()).toBe('init0')
    // Consumed: the canvas must not keep re-centring on it every frame afterwards.
    expect(c.takeFocus()).toBeNull()
  })

  it('keeps only the latest request', () => {
    const c = createGroundController()
    c.focusOn('init0')
    c.focusOn('init1') // double-clicked a second strip before the frame ran
    expect(c.takeFocus()).toBe('init1')
    expect(c.takeFocus()).toBeNull()
  })

  it('is independent of the selection — focusing does not change who is selected', () => {
    const c = createGroundController()
    c.select('init0')
    c.focusOn('init1')
    expect(c.selectedId()).toBe('init0')
    expect(c.takeFocus()).toBe('init1')
  })
})

describe('traffic level', () => {
  /** Run the controller's sim for `seconds` and report how many aircraft were ever on the
   *  field — the whole loop, on the real spawn path, not a hand-built fixture. */
  function seenOver(c: ReturnType<typeof createGroundController>, seconds: number): number {
    const seen = new Set<string>()
    for (let i = 0; i < seconds * 2; i += 1) {
      c.sim.step(0.5)
      for (const a of c.sim.snapshot().aircraft) seen.add(a.id)
    }
    return seen.size
  }

  it('starts at the field\'s own rate', () => {
    expect(createGroundController().trafficRate()).toBe(1)
  })

  it('honours a starting rate, so a saved level survives a reload', () => {
    expect(createGroundController({ trafficRate: 0.35 }).trafficRate()).toBe(0.35)
  })

  it('ignores a nonsense starting rate rather than breaking the field', () => {
    expect(createGroundController({ trafficRate: Number.NaN }).trafficRate()).toBe(1)
  })

  it('turning traffic off stops new arrivals but keeps the ones being worked', () => {
    const c = createGroundController()
    const before = c.sim.snapshot().aircraft.length
    expect(before).toBeGreaterThan(0)
    c.setTrafficRate(0)
    expect(seenOver(c, 600)).toBe(before)
    expect(c.notice()).toMatch(/traffic off/i)
  })

  it('generates less traffic at LOW than at the default', () => {
    const low = createGroundController({ trafficRate: 0.35 })
    const normal = createGroundController()
    expect(seenOver(low, 900)).toBeLessThan(seenOver(normal, 900))
  })
})
