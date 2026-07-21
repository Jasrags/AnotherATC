import type { Point } from '../world/types'
import type { AircraftInit } from './sim'

/** ICAO wake turbulence category: Light / Medium / Heavy / Super. */
export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/** Ground phase — drives the flight-strip state machine and available actions. */
export type GroundStatus =
  | 'parked'
  | 'pushback'
  | 'taxi'
  | 'holding'
  | 'holdShort'
  | 'lineUpWait'
  | 'departing'

/** Why the aircraft is on the surface: leaving (to the runway) or arriving (to a gate). */
export type GroundIntent = 'departure' | 'arrival'

/** Which controller position currently owns the aircraft. Handoffs flip this; each position's
 *  strips and commands are filtered to the aircraft it controls (see docs/atc-tower.md). */
export type ControllerPosition = 'ground' | 'tower'

/** A controller instruction to the surface simulation. */
export type GroundCommand =
  | { type: 'taxiTo'; aircraftId: string; dest: Point; exact?: boolean }
  | { type: 'taxiToGoal'; aircraftId: string }
  | { type: 'taxiVia'; aircraftId: string; taxiways: string[]; dest: Point; exact?: boolean }
  | { type: 'taxiViaGoal'; aircraftId: string; taxiways: string[] }
  | { type: 'pushback'; aircraftId: string }
  | { type: 'hold'; aircraftId: string }
  | { type: 'resume'; aircraftId: string }
  | { type: 'crossRunway'; aircraftId: string }
  | { type: 'giveWay'; aircraftId: string; toId: string }
  | { type: 'contactTower'; aircraftId: string }
  | { type: 'lineUpAndWait'; aircraftId: string }
  | { type: 'clearedForTakeoff'; aircraftId: string }
  | { type: 'clearance'; aircraftId: string }

/** Progress of one parallel ground service (fuel, cargo, cabin, …) on a parked departure. */
export interface ServiceProgress {
  /** Service name, e.g. "fuel". */
  kind: string
  /** Total service duration in seconds. */
  total: number
  /** Seconds of work still remaining (0 = complete). */
  remaining: number
}

/** A pickable, named place a controller can clear an aircraft to. */
export interface NamedDestination {
  id: string
  label: string
  kind: 'runway' | 'gate' | 'spot'
  point: Point
}

/** An aircraft on the airport surface, as seen by a consumer (immutable snapshot). */
export interface GroundAircraft {
  id: string
  callsign: string
  /** ICAO type designator, e.g. "B738". */
  type: string
  wake: WakeCategory
  /** Position in local nm: x = east, y = north (relative to airport ref). */
  x: number
  y: number
  /** Direction of travel, degrees true (0 = north, 90 = east). */
  heading: number
  /** Groundspeed in knots. */
  groundspeed: number
  /** Stopped with a zero-speed target: either at the end of its route, or held mid-route
   * by traffic separation, a junction reservation, or a give-way instruction. */
  holding: boolean
  /** Stopped at a runway hold-short line, awaiting a crossing clearance. */
  holdShort: boolean
  /** Holding short of its *own departure runway* (a takeoff hold, eligible for a tower
   *  handoff) rather than holding short to cross the runway. False unless holdShort. */
  holdingForTakeoff: boolean
  /** Coarse ground phase for the flight strip. */
  status: GroundStatus
  /** Which controller owns the aircraft: Ground until a Tower handoff, then Tower. */
  controlledBy: ControllerPosition
  /** Departure (heading to the runway) or arrival (heading to a gate). */
  intent: GroundIntent
  /** Assigned gate: origin for departures, destination for arrivals (null if none). */
  gate: string | null
  /** Too close to another aircraft — a separation conflict. */
  conflict: boolean
  /** Callsign of the traffic this aircraft has been told to give way to, or null. */
  giveWayTo: string | null
  /** Assigned transponder (beacon) code once IFR clearance is delivered, or null. */
  squawk: string | null
  /** Seconds of wake-turbulence separation still required before this holding-short
   *  departure can be released for takeoff; 0 when none applies. */
  wakeHoldSec: number
  /** Parallel ground services on a parked departure (fuel/cargo/…); empty when none apply. */
  services: readonly ServiceProgress[]
  /** Seconds until the longest ground service finishes and pushback unlocks; 0 when ready/none. */
  serviceSec: number
}

export interface GroundSnapshot {
  /** Elapsed simulated seconds. */
  time: number
  aircraft: GroundAircraft[]
  /** Departures completed (reached the runway). */
  departed: number
  /** Arrivals completed (reached a gate). */
  arrived: number
}

/** Outcome of a dispatched command: accepted, or refused with a controller-facing reason. */
export type DispatchResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface GroundSim {
  /** Advance the simulation by a fixed timestep (seconds). */
  step(dtSeconds: number): void
  /** An immutable view of current state for rendering. */
  snapshot(): GroundSnapshot
  /** Apply a controller instruction (requires a taxi graph for routing). Returns whether
   *  it was accepted, or a reason it was refused (occupied runway, unknown aircraft, …). */
  dispatch(command: GroundCommand): DispatchResult
  /** Remaining route waypoints for an aircraft (for drawing); [] if none. */
  routeOf(aircraftId: string): Point[]
  /** The named taxiways the aircraft's current route follows, in order (e.g. ["A","B"]). */
  taxiwaysOf(aircraftId: string): string[]
  /** Insert an aircraft at runtime (dev/admin sandbox); returns its id. */
  add(init: AircraftInit): string
  /** Remove an aircraft by id; returns whether one was removed. */
  remove(aircraftId: string): boolean
  /** Remove every aircraft from the surface. */
  clear(): void
}
