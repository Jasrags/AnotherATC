import type { Point } from '../world/types'

/** ICAO wake turbulence category: Light / Medium / Heavy / Super. */
export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/** Ground phase — drives the flight-strip state machine and available actions. */
export type GroundStatus = 'parked' | 'pushback' | 'taxi' | 'holding' | 'holdShort' | 'departing'

/** Why the aircraft is on the surface: leaving (to the runway) or arriving (to a gate). */
export type GroundIntent = 'departure' | 'arrival'

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
  | { type: 'clearance'; aircraftId: string }

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
  /** Coarse ground phase for the flight strip. */
  status: GroundStatus
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
}
