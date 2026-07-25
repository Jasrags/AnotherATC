import type { Point } from '../world/types'
import type { WakeCategory, DispatchResult } from '../ground/types'

/**
 * TRACON terminal sim — the deterministic airborne core (docs/atc-tracon.md). Headless, zero UI: an
 * aircraft is kinematic state (position, altitude, heading, speed) plus the targets it is turning,
 * climbing, and slowing toward. Each tick it eases its state toward those targets at engine-constant
 * rates and advances along its heading. Same contract as the ground sim — commands in, immutable
 * snapshots out — and the same determinism guarantee: same inits + same command sequence produce the
 * same radar picture, tick for tick (never Math.random / Date.now).
 *
 * The rates below are engine constants, not airport data: a standard-rate turn is 3°/s at every
 * field (docs/atc-tracon.md §5). Feeder fixes, procedures, and boundary geometry — the things that
 * *would* be wrong at another airport — live on the Airport bundle and enter later slices.
 */

/** Standard-rate turn (deg/s). */
export const TURN_RATE_DEG_S = 3
/** Vertical rates (ft/s): ~1,500 fpm climb, ~1,800 fpm descent — the terminal-area norm. */
export const CLIMB_RATE_FT_S = 25
export const DESCENT_RATE_FT_S = 30
/** Speed change (kt/s). */
export const ACCEL_KT_S = 1.5
/** Radar history: one trail point every {@link TRAIL_SAMPLE_S}, keeping the most recent
 *  {@link TRAIL_MAX} — ~40 s of track behind each target. */
export const TRAIL_SAMPLE_S = 4
export const TRAIL_MAX = 10

export interface TerminalAircraftInit {
  id: string
  callsign: string
  type: string
  wake: WakeCategory
  /** Local nm from the field reference (x = east, y = north), the same frame as the ground surface. */
  position: Point
  altitudeFt: number
  /** True heading, degrees; 0 = north, 90 = east. */
  headingDeg: number
  speedKt: number
  /** Initial assignments; each defaults to the matching current value (so it flies straight, level,
   *  constant speed until vectored). */
  targetHeadingDeg?: number
  targetAltitudeFt?: number
  targetSpeedKt?: number
}

/** Slice 1 vocabulary: a heading vector. Altitude/speed/approach commands arrive in later slices. */
export type TerminalCommand = { type: 'vectorHeading'; aircraftId: string; headingDeg: number }

export interface TerminalAircraft {
  id: string
  callsign: string
  type: string
  wake: WakeCategory
  position: Point
  altitudeFt: number
  headingDeg: number
  speedKt: number
  targetHeadingDeg: number
  targetAltitudeFt: number
  targetSpeedKt: number
  /** Recent positions, oldest first — the radar trail. */
  trail: readonly Point[]
}

export interface TerminalSnapshot {
  time: number
  aircraft: TerminalAircraft[]
}

export interface TerminalSim {
  /** Advance by a fixed timestep (seconds). */
  step(dtSeconds: number): void
  dispatch(command: TerminalCommand): DispatchResult
  snapshot(): TerminalSnapshot
}

/** The mutable working record; the snapshot is derived immutably from it each call. */
interface Internal {
  id: string
  callsign: string
  type: string
  wake: WakeCategory
  x: number
  y: number
  altitudeFt: number
  headingDeg: number
  speedKt: number
  targetHeadingDeg: number
  targetAltitudeFt: number
  targetSpeedKt: number
  trail: Point[]
  sinceTrail: number
}

const DEG = Math.PI / 180
/** Normalize to [0, 360). */
const norm360 = (d: number): number => ((d % 360) + 360) % 360
/** Signed shortest angular difference a→b, in (-180, 180]. */
const shortestDelta = (a: number, b: number): number => ((b - a + 540) % 360) - 180
/** Move `cur` toward `to` by at most `maxStep` (both signs handled). */
const toward = (cur: number, to: number, maxStep: number): number => {
  const d = to - cur
  if (Math.abs(d) <= maxStep) return to
  return cur + Math.sign(d) * maxStep
}

const ACCEPTED: DispatchResult = { ok: true }
const refused = (reason: string): DispatchResult => ({ ok: false, reason })

export function createTerminalSim(inits: readonly TerminalAircraftInit[]): TerminalSim {
  let time = 0
  const fleet: Internal[] = inits.map((init) => ({
    id: init.id,
    callsign: init.callsign,
    type: init.type,
    wake: init.wake,
    x: init.position[0],
    y: init.position[1],
    altitudeFt: init.altitudeFt,
    headingDeg: norm360(init.headingDeg),
    speedKt: init.speedKt,
    targetHeadingDeg: norm360(init.targetHeadingDeg ?? init.headingDeg),
    targetAltitudeFt: init.targetAltitudeFt ?? init.altitudeFt,
    targetSpeedKt: init.targetSpeedKt ?? init.speedKt,
    trail: [[init.position[0], init.position[1]]],
    sinceTrail: 0,
  }))
  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  const step = (dt: number): void => {
    for (const ac of fleet) {
      // Turn toward the assigned heading at the standard rate, the short way.
      const dHead = shortestDelta(ac.headingDeg, ac.targetHeadingDeg)
      const turn = Math.sign(dHead) * Math.min(Math.abs(dHead), TURN_RATE_DEG_S * dt)
      ac.headingDeg = norm360(ac.headingDeg + turn)
      // Ease altitude toward the assigned altitude at the climb/descent rate.
      const vRate = ac.targetAltitudeFt >= ac.altitudeFt ? CLIMB_RATE_FT_S : DESCENT_RATE_FT_S
      ac.altitudeFt = toward(ac.altitudeFt, ac.targetAltitudeFt, vRate * dt)
      // Ease speed toward the assigned speed.
      ac.speedKt = toward(ac.speedKt, ac.targetSpeedKt, ACCEL_KT_S * dt)
      // Advance along the (new) heading. speed is nm/hour, dt seconds.
      const distNm = (ac.speedKt * dt) / 3600
      ac.x += distNm * Math.sin(ac.headingDeg * DEG)
      ac.y += distNm * Math.cos(ac.headingDeg * DEG)
      // Sample the radar trail on a fixed cadence.
      ac.sinceTrail += dt
      if (ac.sinceTrail >= TRAIL_SAMPLE_S) {
        ac.sinceTrail -= TRAIL_SAMPLE_S
        ac.trail.push([ac.x, ac.y])
        if (ac.trail.length > TRAIL_MAX) ac.trail.shift()
      }
    }
    time += dt
  }

  const dispatch = (command: TerminalCommand): DispatchResult => {
    const ac = find(command.aircraftId)
    if (!ac) return refused('unknown aircraft')
    switch (command.type) {
      case 'vectorHeading':
        if (!Number.isFinite(command.headingDeg)) return refused('heading must be a number')
        ac.targetHeadingDeg = norm360(command.headingDeg)
        return ACCEPTED
      default:
        return refused('unknown command')
    }
  }

  const snapshot = (): TerminalSnapshot => ({
    time,
    aircraft: fleet.map((ac) => ({
      id: ac.id,
      callsign: ac.callsign,
      type: ac.type,
      wake: ac.wake,
      position: [ac.x, ac.y] as Point,
      altitudeFt: ac.altitudeFt,
      headingDeg: ac.headingDeg,
      speedKt: ac.speedKt,
      targetHeadingDeg: ac.targetHeadingDeg,
      targetAltitudeFt: ac.targetAltitudeFt,
      targetSpeedKt: ac.targetSpeedKt,
      trail: ac.trail.map((p) => [p[0], p[1]] as Point),
    })),
  })

  return { step, dispatch, snapshot }
}
