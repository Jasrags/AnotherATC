import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface, Point } from '../world/types'

// One runway (y=0, x 0→2), a parallel taxiway south of it, two right-angle connectors at the
// ends, and one acute rapid-exit turnoff mid-field — enough for an arrival to land on 09, take
// the high-speed off, and taxi to the gate.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: -0.3, maxX: 2, maxY: 0 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    { kind: 'taxiway', ref: 'A', points: [[0.2, -0.2], [1, -0.2], [1.5, -0.2], [1.8, -0.2]] },
    { kind: 'taxiway', ref: 'E1', points: [[0.2, -0.2], [0.2, -0.02]] }, // 90°, first half
    { kind: 'taxiway', ref: 'E5', points: [[1.1, 0], [1.35, -0.12], [1.5, -0.2]] }, // rapid exit
    { kind: 'taxiway', ref: 'E9', points: [[1.8, -0.2], [1.8, -0.02]] }, // 90° connector, east
  ],
}
const guard = buildRunwayGuard(surface)
const graph = buildTaxiGraph(surface)

// East end of the parallel, i.e. *ahead* of a landing rollout. It used to sit at the west end,
// which meant reaching it from the rapid exit required turning back through 152° onto taxiway A
// — a hairpin no aircraft can make, and one the router now refuses. A real field serves a
// landing direction with stands it can reach going forward.
const GATE: Point = [1.8, -0.2]
const THRESHOLD: Point = [0, 0] // RWY 9, landing to the east
const FIX: Point = [-4, 0] // 4 nm final, on the extended centerline

/** An arrival established on final: airborne from the fix to the landing threshold. */
function arrivalOnFinal(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [FIX, THRESHOLD],
    targetSpeed: 140,
    airborne: true,
    intent: 'arrival',
    goalPoint: GATE,
    gate: 'A1',
  }
}

/** A departure taxiing north to hold short of the runway at x, with its goal on it. */
function departure(id: string, x = 1.8): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[x, -0.5], [x, -0.1], [x, 0.1], [x, 0.5]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [x, 0],
  }
}

const A = (sim: ReturnType<typeof createGroundSim>, id: string) =>
  sim.snapshot().aircraft.find((a) => a.id === id)
const run = (sim: ReturnType<typeof createGroundSim>, steps: number) => {
  for (let i = 0; i < steps; i += 1) sim.step(0.1)
}

describe('arrivals on final', () => {
  it('spawns airborne on the extended centerline, owned by Tower', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    const a = A(sim, 'a')!
    expect(a.status).toBe('onFinal')
    expect(a.controlledBy).toBe('tower')
    expect(a.altitude).toBeGreaterThan(1000)
    expect(a.finalNm).toBeCloseTo(4, 1)
    expect(a.onRunway).toBe(false) // airborne — not a surface occupant
  })

  it('descends toward the threshold deterministically', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    const start = A(sim, 'a')!
    run(sim, 300) // 30 s of final
    const mid = A(sim, 'a')!
    expect(mid.x).toBeGreaterThan(start.x) // tracking inbound
    expect(mid.altitude).toBeLessThan(start.altitude) // and descending
    expect(mid.finalNm).toBeLessThan(start.finalNm)
    expect(mid.altitude).toBeGreaterThan(0) // still airborne 3 nm out

    const again = createGroundSim([arrivalOnFinal('a')], { guard })
    run(again, 300)
    expect(A(again, 'a')).toEqual(mid) // deterministic
  })

  it('goes around when it reaches the threshold without a landing clearance', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    run(sim, 1100) // the full ~103 s final, never cleared
    const a = A(sim, 'a')!
    expect(a.status).toBe('onFinal') // re-established on a fresh final, not landed
    expect(a.altitude).toBeGreaterThan(1000)
    expect(a.finalNm).toBeGreaterThan(3)
    expect(sim.snapshot().arrived).toBe(0)
  })
})

describe('landing clearance', () => {
  it('cleared to land → touchdown at the threshold, then rollout on the runway', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    run(sim, 200)
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })
    expect(A(sim, 'a')!.status).toBe('landing')

    let atTouchdown: ReturnType<typeof A> = undefined
    let slowedTo = 140
    for (let i = 0; i < 1500; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a) break
      if (a.status === 'rollout') {
        if (!atTouchdown) atTouchdown = a
        slowedTo = Math.min(slowedTo, a.groundspeed)
      }
    }
    expect(atTouchdown).toBeDefined()
    expect(atTouchdown!.x).toBeCloseTo(THRESHOLD[0], 1) // touched down at the threshold
    expect(atTouchdown!.altitude).toBe(0)
    expect(Math.abs(atTouchdown!.y)).toBeLessThan(0.02) // on the centerline
    expect(slowedTo).toBeLessThan(140) // and braked on the roll
  })

  it('refuses a landing clearance while a departure occupies the runway', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard })
    run(sim, 1500) // d taxis up and holds short
    expect(A(sim, 'd')!.holdShort).toBe(true)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    run(sim, 400) // d is now lined up on the runway
    expect(A(sim, 'd')!.status).toBe('lineUpWait')

    // The arrival went around meanwhile; clear it to land onto the occupied runway.
    const res = sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    expect(res).toEqual({ ok: false, reason: 'runway occupied' })
  })

  it('refuses a takeoff clearance and a line-up while an arrival is on short final', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard })
    run(sim, 1500)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    // Fly in to short final (< 1.5 nm from the threshold).
    for (let i = 0; i < 1200 && (A(sim, 'a')?.finalNm ?? 0) > 1; i += 1) sim.step(0.1)
    expect(A(sim, 'a')!.finalNm).toBeLessThan(1.5)

    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
  })

  it('refuses a landing clearance to anything but a Tower arrival on final', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'only arrivals are cleared to land',
    })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({
      ok: false,
      reason: 'already cleared to land',
    })
  })
})

describe('ground commands are refused to an aircraft in the air', () => {
  // The sim is the authority, not the menu: a surface command dispatched to an aircraft on
  // final used to be accepted, which could stop it dead in mid-air (never landing, never
  // going around) or taxi an "airborne" target across the field on a graph route.
  const groundCommands = [
    { type: 'hold' as const, aircraftId: 'a' },
    { type: 'resume' as const, aircraftId: 'a' },
    { type: 'taxiTo' as const, aircraftId: 'a', dest: GATE },
    { type: 'taxiToGoal' as const, aircraftId: 'a' },
    { type: 'taxiVia' as const, aircraftId: 'a', taxiways: [], dest: GATE },
    { type: 'taxiViaGoal' as const, aircraftId: 'a', taxiways: [] },
  ]

  it.each(groundCommands.map((c) => [c.type, c] as const))('refuses %s on final', (_type, cmd) => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    expect(sim.dispatch(cmd)).toEqual({ ok: false, reason: 'aircraft is airborne' })
  })

  it('an attempted hold does not freeze an arrival in mid-air', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    sim.dispatch({ type: 'hold', aircraftId: 'a' })
    run(sim, 300)
    const a = A(sim, 'a')!
    expect(a.groundspeed).toBeGreaterThan(100) // still flying the approach
    expect(a.finalNm).toBeLessThan(4)
  })

  it('accepts them again once it is on the ground under Ground control', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactGround', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.controlledBy !== 'ground'; i += 1) sim.step(0.1)
    expect(A(sim, 'a')!.controlledBy).toBe('ground')
    expect(sim.dispatch({ type: 'hold', aircraftId: 'a' })).toEqual({ ok: true })
  })
})

describe('airborne arrivals must be constructed with a gate to taxi to', () => {
  it('refuses an airborne init with no goalPoint rather than stranding it on the runway', () => {
    // Without a goal the rollout hands to Ground with nowhere to go: it stops on the runway,
    // is never counted arrived, is never removed, and blocks the runway for everyone else.
    const bad: AircraftInit = {
      id: 'x',
      callsign: 'x',
      type: 'B738',
      wake: 'M',
      path: [FIX, THRESHOLD],
      targetSpeed: 140,
      airborne: true,
      intent: 'arrival',
    }
    expect(() => createGroundSim([bad], { guard, graph })).toThrow(/goalPoint/)
  })
})

describe('arrival end-to-end: final → land → exit → Ground → gate', () => {
  it('lands, is handed to Ground on rollout, taxis to its gate and counts as arrived', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })

    const seen = new Set<string>()
    let handedToGroundAt = -1
    let sentToGround = false
    let taxied = false
    for (let i = 0; i < 8000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a) break
      seen.add(a.status)
      // Tower issues the frequency change during the rollout — "when vacated, contact ground".
      if (a.status === 'rollout' && !sentToGround) {
        sentToGround = true
        expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({ ok: true })
      }
      if (a.controlledBy === 'ground' && handedToGroundAt < 0) handedToGroundAt = sim.snapshot().time
      // …and Ground taxis it in, which is a second instruction: the handoff only moved it to
      // this frequency, it did not send it anywhere.
      if (a.controlledBy === 'ground' && !taxied) {
        taxied = true
        expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })).toEqual({ ok: true })
      }
    }

    expect(seen.has('landing')).toBe(true)
    expect(seen.has('rollout')).toBe(true)
    expect(seen.has('taxi')).toBe(true) // handed to Ground and taxiing off the runway
    expect(handedToGroundAt).toBeGreaterThan(0)
    expect(A(sim, 'a')).toBeUndefined() // parked, dwelled, cleared the stand
    expect(sim.snapshot().arrived).toBe(1)
  })

  it('lets a waiting departure go once the arrival has cleared the runway', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    run(sim, 1500)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })

    // While the arrival is on the runway, the departure cannot be released.
    for (let i = 0; i < 2000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a || a.vacated) break
      expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
        ok: false,
        reason: 'runway occupied',
      })
    }

    // Once it has exited, the runway is available again.
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    // Longer than the roll alone: cleared from hold-short it taxis into position first.
    for (let i = 0; i < 2000 && sim.snapshot().departed < 1; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })
})

describe('runway exits: the turnoff is chosen, not stumbled into', () => {
  const landed = () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 2000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    return sim
  }

  it('offers only turnoffs ahead of the aircraft that it can still slow down for', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    const refs = sim.exitOptions('a').map((e) => e.ref)
    expect(refs).toContain('E5') // the mid-field rapid exit
    expect(refs).toContain('E9') // the far right-angle connector
    expect(refs).not.toContain('E1') // in the first half of the runway — not a landing exit
  })

  it('plans the rapid exit by default, because it frees the runway soonest', () => {
    const sim = landed()
    expect(A(sim, 'a')!.exitRef).toBe('E5')
  })

  it('actually leaves the runway at the planned turnoff, at its speed', () => {
    const sim = landed()
    let speedAtExit = -1
    for (let i = 0; i < 2000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a) break
      // 1.1 is where E5 meets the runway; sample the speed as it arrives there.
      if (speedAtExit < 0 && a.x >= 1.1) speedAtExit = a.groundspeed
      if (a.vacated) break
    }
    expect(speedAtExit).toBeGreaterThan(25) // took the high-speed at speed, not at a crawl
    expect(speedAtExit).toBeLessThanOrEqual(45)
    const a = A(sim, 'a')!
    expect(a.vacated).toBe(true)
    expect(a.y).toBeLessThan(-0.1) // off the runway, down the turnoff
  })

  it('a far turnoff can be assigned instead, and costs runway occupancy', () => {
    const rot = (assign?: string): number => {
      const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
      sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
      if (assign) expect(sim.dispatch({ type: 'assignExit', aircraftId: 'a', ref: assign })).toEqual({ ok: true })
      let touchdown = -1
      for (let i = 0; i < 4000; i += 1) {
        sim.step(0.1)
        const a = A(sim, 'a')
        if (!a) break
        if (touchdown < 0 && a.status === 'rollout') touchdown = sim.snapshot().time
        if (a.vacated) return sim.snapshot().time - touchdown
      }
      return Infinity
    }
    const viaRapid = rot()
    const viaFarEnd = rot('E9')
    expect(viaFarEnd).toBeGreaterThan(viaRapid + 15) // the whole reason RETs exist
  })

  it('refuses a turnoff the aircraft cannot slow down for', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    expect(sim.dispatch({ type: 'assignExit', aircraftId: 'a', ref: 'E1' })).toEqual({
      ok: false,
      reason: 'unable E1 — cannot slow down in time',
    })
  })
})

describe('Tower → Ground: the pilot never switches frequency unprompted', () => {
  const rollingOut = () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 2000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    return sim
  }

  it('stays with Tower after vacating until Tower issues the frequency change', () => {
    const sim = rollingOut()
    for (let i = 0; i < 2000; i += 1) sim.step(0.1)
    const a = A(sim, 'a')!
    expect(a.vacated).toBe(true) // clear of the runway…
    expect(a.controlledBy).toBe('tower') // …but still Tower's, waiting to be sent to Ground
    expect(sim.snapshot().arrived).toBe(0)
  })

  it('"when vacated, contact ground" issued on the roll takes effect on vacating', () => {
    const sim = rollingOut()
    expect(A(sim, 'a')!.vacated).toBe(false)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({ ok: true })
    expect(A(sim, 'a')!.controlledBy).toBe('tower') // not yet — it is still on the runway
    for (let i = 0; i < 3000 && A(sim, 'a')?.controlledBy !== 'ground'; i += 1) sim.step(0.1)
    expect(A(sim, 'a')!.controlledBy).toBe('ground')
    expect(A(sim, 'a')!.vacated).toBe(false) // no longer rolling out — it is taxiing now
  })

  it('holds the runway against a departure until it has actually vacated', () => {
    // A departure already at the hold line, so it is waiting on Tower well before touchdown.
    const dep: AircraftInit = {
      id: 'd', callsign: 'd', type: 'B738', wake: 'M',
      path: [[1.8, -0.14], [1.8, -0.1], [1.8, 0.1], [1.8, 0.5]],
      targetSpeed: 15, intent: 'departure', goalPoint: [1.8, 0],
    }
    const sim = createGroundSim([arrivalOnFinal('a'), dep], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    run(sim, 300)
    expect(A(sim, 'd')!.holdShort).toBe(true)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })

    let refusals = 0
    let releasedWhileOnRunway = false
    for (let i = 0; i < 4000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a) break
      if (a.vacated) break // clear of the runway — the departure may go now
      if (a.status !== 'rollout') continue
      const res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
      if (res.ok) releasedWhileOnRunway = true
      else refusals += 1
    }
    expect(refusals).toBeGreaterThan(0) // it really was asked while the arrival was rolling
    expect(releasedWhileOnRunway).toBe(false)
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
  })

  it('refuses the handoff before touchdown and twice', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({
      ok: false,
      reason: 'still airborne',
    })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 2000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({
      ok: false,
      reason: 'already sent to ground',
    })
  })
})

describe('the handoff to Ground is a frequency change, not a taxi clearance', () => {
  /** Land an arrival, send it to Ground, and run until it is on Ground's frequency and stopped. */
  function landedAndCheckedIn() {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({ ok: true })
    for (let i = 0; i < 4000 && A(sim, 'a')?.controlledBy !== 'ground'; i += 1) sim.step(0.1)
    return sim
  }

  it('leaves the aircraft stopped clear of the runway, awaiting a taxi clearance', () => {
    const sim = landedAndCheckedIn()
    run(sim, 600) // a minute on Ground's frequency with nothing issued to it
    const a = A(sim, 'a')!
    expect(a.controlledBy).toBe('ground')
    expect(a.onRunway).toBe(false) // it cleared the runway on its landing rollout…
    expect(a.groundspeed).toBe(0) // …and then stopped, because nobody has taxied it
    expect(a.status).toBe('holding')
    // Nowhere near the gate: the handoff must not have routed it there.
    expect(Math.hypot(a.x - GATE[0], a.y - GATE[1])).toBeGreaterThan(0.05)
    expect(sim.snapshot().arrived).toBe(0)
  })

  it('checks in with Ground, and says nothing about taxiing until Ground taxis it', () => {
    const sim = landedAndCheckedIn()
    const checkIn = sim.snapshot().comms.at(-1)!
    expect(checkIn.from).toBe('pilot')
    expect(checkIn.position).toBe('ground')
    expect(checkIn.text).toMatch(/clear of the runway/i)

    run(sim, 300)
    expect(sim.snapshot().comms.at(-1)!.text).toBe(checkIn.text) // nothing further was said
  })

  it('taxis to the gate once Ground actually clears it to, and counts as arrived', () => {
    const sim = landedAndCheckedIn()
    expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })).toEqual({ ok: true })
    for (let i = 0; i < 8000 && A(sim, 'a'); i += 1) sim.step(0.1)
    expect(A(sim, 'a')).toBeUndefined() // parked, dwelled, cleared the stand
    expect(sim.snapshot().arrived).toBe(1)
  })
})

describe('"continue taxi" needs a taxi to continue', () => {
  it('is refused to an arrival that has checked in with Ground but been given nothing', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactGround', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.controlledBy !== 'ground'; i += 1) sim.step(0.1)

    // Silently accepting this is how "contact ground" came to look like a taxi clearance: the
    // aircraft has no route, so there is nothing to resume, and saying so is the point.
    expect(sim.dispatch({ type: 'resume', aircraftId: 'a' })).toEqual({
      ok: false,
      reason: 'nothing to continue — no clearance to run',
    })
    run(sim, 100)
    expect(A(sim, 'a')!.groundspeed).toBe(0)
  })

  it('is accepted once Ground has actually cleared it to taxi', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactGround', aircraftId: 'a' })
    for (let i = 0; i < 4000 && A(sim, 'a')?.controlledBy !== 'ground'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })
    sim.dispatch({ type: 'hold', aircraftId: 'a' })
    expect(sim.dispatch({ type: 'resume', aircraftId: 'a' })).toEqual({ ok: true })
    run(sim, 100)
    expect(A(sim, 'a')!.groundspeed).toBeGreaterThan(0)
  })
})

/**
 * Line up and wait behind a landing aircraft.
 *
 * The situation LUAW exists for, in the words of docs/atc-operations.md §6: "the runway is not
 * quite clear — *a landing aircraft is still rolling out* — so rather than hold the departure on
 * the taxiway, Tower puts it on the runway ready to go." The sim used to refuse exactly that,
 * which left the instruction usable only when it was least needed.
 *
 * The line is whether the arrival has *landed*. On short final it is still going to touch down,
 * and putting an aircraft on the runway underneath it is the accident the incursion machinery
 * exists for. Once it is rolling out it is leaving, and the departure lines up behind it.
 */
describe('line up and wait behind landing traffic', () => {
  /** A departure at the hold-short line, handed to Tower, ready to be worked. */
  function ready(sim: ReturnType<typeof createGroundSim>, id: string) {
    for (let i = 0; i < 2000 && !A(sim, id)?.holdShort; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: id })).toEqual({ ok: true })
  }

  it('refuses a line-up under an aircraft still on short final', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    ready(sim, 'd')
    for (let i = 0; i < 4000 && !A(sim, 'a')?.onShortFinal; i += 1) sim.step(0.1)
    expect(A(sim, 'a')!.onShortFinal).toBe(true)
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
  })

  it('allows it behind an arrival that has touched down and is rolling out', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    ready(sim, 'd')
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    expect(A(sim, 'a')!.onRunway).toBe(true) // still on the pavement, and still leaving it

    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    expect(A(sim, 'd')!.status).toBe('lineUpWait')
  })

  it('tells the departure what it is lining up behind', () => {
    // FAA 7110.65 requires the traffic to be issued with the instruction: an aircraft told to
    // enter a runway with something else on it is owed the reason.
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    ready(sim, 'd')
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })

    const [instruction, readback] = sim.snapshot().comms.slice(-2)
    expect(instruction!.text).toMatch(/line up and wait/i)
    expect(instruction!.text).toMatch(/traffic landing/i)
    expect(readback!.text).toMatch(/line up and wait/i)
  })

  it('still refuses a takeoff clearance until that arrival is off the runway', () => {
    // The line-up is the whole concession. The takeoff clearance keeps the stricter bar, which
    // is what makes lining up early useful rather than merely earlier.
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    ready(sim, 'd')
    for (let i = 0; i < 4000 && A(sim, 'a')?.status !== 'rollout'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
  })

  it('still refuses a second aircraft onto the runway', () => {
    // One aircraft in position at a time. A rollout is leaving; a lined-up departure is not.
    const sim = createGroundSim([departure('d'), departure('e', 1.5)], { guard, graph })
    ready(sim, 'd')
    ready(sim, 'e')
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'e' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
  })
})

describe('the alert must not fire on the instruction the sim just gave', () => {
  /** A departure at the hold-short line, handed to Tower. */
  function ready(sim: ReturnType<typeof createGroundSim>, id: string) {
    for (let i = 0; i < 2000 && !A(sim, id)?.holdShort; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: id })).toEqual({ ok: true })
  }

  it('clears one for takeoff, lines the next up behind it, and says nothing', () => {
    // Played exactly as reported: #1 rolling, #2 lined up behind. The pair was raising a
    // runway-incursion alert — for a sequence the sim had accepted on purpose.
    const sim = createGroundSim([departure('d'), departure('e', 1.5)], { guard, graph })
    ready(sim, 'd')
    ready(sim, 'e')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })

    let alerted: string | null = null
    let sawBothOnRunway = false
    for (let i = 0; i < 3000; i += 1) {
      sim.step(0.1)
      const snap = sim.snapshot()
      const d = A(sim, 'd')
      // Line #2 up the moment #1 is genuinely rolling, which is what the instruction is for.
      if (d && d.status === 'departing' && d.groundspeed > 30 && A(sim, 'e')?.status === 'holdShort') {
        expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'e' })).toEqual({ ok: true })
      }
      if (d?.onRunway && A(sim, 'e')?.onRunway) sawBothOnRunway = true
      if (snap.incursions.length > 0 && !alerted) alerted = snap.incursions[0]!.message
    }

    expect(sawBothOnRunway).toBe(true) // the situation really did occur…
    expect(alerted).toBeNull() // …and nothing was shouted about it
    expect(sim.snapshot().departed).toBe(1)
  })

  it('still alerts when the one behind lines up before the first has moved', () => {
    // The same two aircraft, one instruction earlier. This is the real thing: an aircraft
    // taxiing onto a runway another is sitting on, cleared or not.
    const sim = createGroundSim([departure('d'), departure('e', 1.5)], { guard, graph })
    ready(sim, 'd')
    ready(sim, 'e')
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    for (let i = 0; i < 600 && !A(sim, 'd')?.onRunway; i += 1) sim.step(0.1)
    expect(A(sim, 'd')!.onRunway).toBe(true)

    // Refused, because one aircraft is in position at a time — so the alert cannot even be
    // reached through the menu. The detector is the backstop for the ways it can be reached:
    // the dev sandbox, and any future path that puts two aircraft on one runway.
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'e' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
  })
})
