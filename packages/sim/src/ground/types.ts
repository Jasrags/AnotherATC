/** ICAO wake turbulence category: Light / Medium / Heavy / Super. */
export type WakeCategory = 'L' | 'M' | 'H' | 'J'

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
}

export interface GroundSnapshot {
  /** Elapsed simulated seconds. */
  time: number
  aircraft: GroundAircraft[]
}

export interface GroundSim {
  /** Advance the simulation by a fixed timestep (seconds). */
  step(dtSeconds: number): void
  /** An immutable view of current state for rendering. */
  snapshot(): GroundSnapshot
}
