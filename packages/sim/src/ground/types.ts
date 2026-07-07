import type { Point } from '../world/types'

/** ICAO wake turbulence category: Light / Medium / Heavy / Super. */
export type WakeCategory = 'L' | 'M' | 'H' | 'J'

/** Ground phase — drives the flight-strip state machine and available actions. */
export type GroundStatus = 'parked' | 'taxi' | 'holding' | 'holdShort'

/** Why the aircraft is on the surface: leaving (to the runway) or arriving (to a gate). */
export type GroundIntent = 'departure' | 'arrival'

/** A controller instruction to the surface simulation. */
export type GroundCommand =
  | { type: 'taxiTo'; aircraftId: string; dest: Point; exact?: boolean }
  | { type: 'taxiToGoal'; aircraftId: string }
  | { type: 'hold'; aircraftId: string }
  | { type: 'resume'; aircraftId: string }
  | { type: 'crossRunway'; aircraftId: string }

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
  /** True once the aircraft has reached the end of its route and stopped. */
  holding: boolean
  /** Stopped at a runway hold-short line, awaiting a crossing clearance. */
  holdShort: boolean
  /** Coarse ground phase for the flight strip. */
  status: GroundStatus
  /** Departure (heading to the runway) or arrival (heading to a gate). */
  intent: GroundIntent
  /** Assigned gate: origin for departures, destination for arrivals (null if none). */
  gate: string | null
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

export interface GroundSim {
  /** Advance the simulation by a fixed timestep (seconds). */
  step(dtSeconds: number): void
  /** An immutable view of current state for rendering. */
  snapshot(): GroundSnapshot
  /** Apply a controller instruction (requires a taxi graph for routing). */
  dispatch(command: GroundCommand): void
  /** Remaining route waypoints for an aircraft (for drawing); [] if none. */
  routeOf(aircraftId: string): Point[]
}
