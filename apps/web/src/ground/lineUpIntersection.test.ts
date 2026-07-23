import { describe, it, expect } from 'vitest'
import { createGroundController } from './controller'

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)

/**
 * A takeoff clearance from a mid-field hold short lines up straight ahead — it never taxis the
 * long way round and across its own runway to reach a charted centerline node on the far side.
 *
 * The real report (captured with the dev inspector): a C172 holding short at C3 on runway 27,
 * cleared for takeoff, went west to C4, crossed the runway uncleared, ran east down the far side
 * to B2 and only then took off. lineUpPath routed to the nearest *charted* centerline node, which
 * sat on a connector across the runway, and graph.route looped around the field to reach it.
 * Driven through the exact dev-sandbox sequence that produced it (spawn snaps to a graph node, so
 * this only reproduces through the real spawn path — a hand-placed aircraft holds elsewhere).
 */
describe('an intersection takeoff lines up straight ahead, not across the runway', () => {
  it('does not loop across the runway to line up from a mid-field hold short', () => {
    const c = createGroundController({ dev: true })
    c.setDevType('C172')
    c.spawnAt([0.27, -0.05]) // taxiway C, north of the runway near C3
    const id = c.selectedId()!
    const A = () => c.sim.snapshot().aircraft.find((a) => a.id === id)

    // Taxi across toward C3 so it holds short mid-field (not out at the departure start).
    c.sim.dispatch({ type: 'taxiTo', aircraftId: id, dest: [0.34, -0.16] })
    for (let i = 0; i < 4000 && !A()?.holdShort; i += 1) c.sim.step(0.1)
    const held = A()!
    expect(held.holdShort).toBe(true)

    c.sim.dispatch({ type: 'contactTower', aircraftId: id })
    expect(c.sim.dispatch({ type: 'clearedForTakeoff', aircraftId: id }).ok).toBe(true)

    // The line-up follows the connector's charted curve onto the stripe, not a straight cut with a
    // sharp turn: no vertex may kink more than a gentle amount. The corner-cutting bug turned ~90°.
    const path = c.inspectSelected()!.path
    let maxTurnDeg = 0
    for (let i = 1; i < path.length - 1; i += 1) {
      const [a, b, d] = [path[i - 1]!, path[i]!, path[i + 1]!]
      const h1 = Math.atan2(b[1] - a[1], b[0] - a[0])
      const h2 = Math.atan2(d[1] - b[1], d[0] - b[0])
      let turn = Math.abs(((h2 - h1) * 180) / Math.PI)
      if (turn > 180) turn = 360 - turn
      maxTurnDeg = Math.max(maxTurnDeg, turn)
    }
    expect(maxTurnDeg).toBeLessThan(45)

    // Distance taxied from the clearance until the takeoff roll actually spools up. (status is
    // 'departing' the instant the clearance is issued — rollWhenLinedUp — so speed is the honest
    // signal: the line-up taxis at ~15 kt, the roll accelerates past it.) Pulling straight onto
    // the centerline is a few hundred feet; the loop-and-cross bug was ~1.5 nm.
    let lineUpNm = 0
    let prev: readonly number[] = [held.x, held.y]
    for (let i = 0; i < 6000; i += 1) {
      c.sim.step(0.1)
      const a = A()
      if (!a || a.groundspeed > 30) break // rolling now, not lining up
      lineUpNm += dist([a.x, a.y], prev)
      prev = [a.x, a.y]
    }

    expect(lineUpNm).toBeLessThan(0.3)
  })
})
