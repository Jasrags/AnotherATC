import type { Point } from '../world/types'
import type { AircraftInit } from './sim'
import type { RunwayExit } from './runwayExits'
import type { ActiveRunway } from './runway'
import type { ApproachConfig } from './sim'
import type { Transmission } from './comms'
import type { RunwayIncursion } from './incursion'

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
  /** Arrival established on final approach, awaiting a landing clearance. */
  | 'onFinal'
  /** Arrival on final with a landing clearance, flying it to touchdown. */
  | 'landing'
  /** Arrival decelerating on the runway after touchdown, before it exits. */
  | 'rollout'

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
  /** `facing` is a compass point from {@link GroundSim.pushbackOptions} — which way the
   *  aircraft ends up pointing, and therefore which way it can taxi off the stand. Omitted,
   *  the tug picks whichever direction serves the aircraft's own goal better. */
  | { type: 'pushback'; aircraftId: string; facing?: string }
  | { type: 'hold'; aircraftId: string }
  | { type: 'resume'; aircraftId: string }
  | { type: 'crossRunway'; aircraftId: string }
  /** "Hold short of runway N" — the instruction the whole crossing exchange turns on, and one a
   *  pilot must read back verbatim. Confirms a hold the route already implies, and takes back a
   *  crossing clearance the aircraft has not acted on yet. */
  | { type: 'holdShort'; aircraftId: string }
  | { type: 'giveWay'; aircraftId: string; toId: string }
  | { type: 'contactTower'; aircraftId: string }
  | { type: 'lineUpAndWait'; aircraftId: string }
  | { type: 'clearedForTakeoff'; aircraftId: string }
  | { type: 'clearedToLand'; aircraftId: string }
  /** "Go around" — the controller's call, not the pilot's. The lever the runway-incursion
   *  alert would otherwise leave you without: when the aircraft on the runway cannot be moved
   *  in time, the one in the air is the one you move. */
  | { type: 'goAround'; aircraftId: string }
  /** "Expedite" — run the clearance you already have. The other half of the incursion answer:
   *  get the occupant off the runway rather than sending the inbound around. */
  | { type: 'expedite'; aircraftId: string }
  | { type: 'assignExit'; aircraftId: string; ref: string }
  | { type: 'contactGround'; aircraftId: string }
  | { type: 'clearance'; aircraftId: string }
  /** Send an arrival to a different stand. The lever the gate-conflict alert otherwise leaves
   *  you without: the alternative to waiting for a blocked gate is not taking it. */
  | { type: 'assignStand'; aircraftId: string; ref: string }
  /** "Negative, …" — re-issue the aircraft's last clearance. If the pilot had misheard it, this
   *  is the catch: they act on what the controller actually said. If they hadn't, it is simply a
   *  repeated transmission, which is what makes catching one a judgement rather than a prompt. */
  | { type: 'sayAgain'; aircraftId: string }

/** Progress of one parallel ground service (fuel, cargo, cabin, …) on a parked departure. */
export interface ServiceProgress {
  /** Service name, e.g. "fuel". */
  kind: string
  /** Total service duration in seconds. */
  total: number
  /** Seconds of work still remaining (0 = complete). */
  remaining: number
}

/** A stand an arrival could be reassigned to. */
export interface StandOption {
  ref: string
  /** Distance (nm) from the stand it is currently bound for — nearest alternatives first. */
  distanceNm: number
}

/** One way an aircraft can be pushed back off its stand: onto the alley, facing this way. */
export interface PushbackOption {
  /** Compass point the aircraft ends up facing, e.g. "E" — what the clearance names. */
  facing: string
  headingDeg: number
  /** The taxiway it would be facing down, when that pavement is named. */
  ref: string | null
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
  /** Height above the field in feet; 0 on the surface, > 0 on final approach. */
  altitude: number
  /** Distance (nm) still to fly to the landing threshold; 0 unless on final. */
  finalNm: number
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
  /** Physically on the runway surface right now (a takeoff roll, a line-up, or a crossing). */
  onRunway: boolean
  /** Occupies the *surface* of the runway in a way that blocks another aircraft's takeoff
   *  clearance. True for a stationary occupant (lined up / crossing) and a departure still below
   *  rotation speed; false once a departure has rotated (near liftoff) and the next may be
   *  cleared behind it. Note this is only half of "is the runway available" — see
   *  {@link onShortFinal} for the airborne half; the sim gates clearances on their union. */
  blocksTakeoff: boolean
  /** On final and close enough in to own the runway: nothing may be cleared onto the surface
   *  underneath it (no takeoff, no line-up, no crossing, no second landing). Together with
   *  {@link blocksTakeoff} this is the sim's full runway-clear predicate, exposed so the UI can
   *  gate and explain a clearance exactly as the sim would refuse it. */
  onShortFinal: boolean
  /** Designator of the runway turnoff this arrival is planning for or rolling out to, or null.
   *  Set automatically at touchdown when the controller hasn't assigned one. */
  exitRef: string | null
  /** A landed arrival is fully clear of the runway (past its turnoff's hold-short point) and
   *  can be handed to Ground. False for anything not on a landing roll. */
  vacated: boolean
  /** Tower has issued the frequency change but the aircraft has not vacated yet, so it is
   *  still on Tower's frequency ("when vacated, contact ground"). */
  handoffPending: boolean
  /** Too close to another aircraft — a separation conflict. */
  conflict: boolean
  /** Named in at least one entry of {@link GroundSnapshot.incursions}: on the runway uncleared,
   *  or sharing it with traffic that is landing, lining up or rolling. Unlike {@link conflict}
   *  this is about *authority*, not distance — the two aircraft may be a mile apart. */
  incursion: boolean
  /** A "hold short of runway N" would be accepted: there is a runway ahead on the route to hold
   *  short of, and the aircraft has not already driven onto it. */
  canHoldShort: boolean
  /** An "expedite" would be accepted: there is route left to run, and the aircraft is in a
   *  phase where the target speed is what governs. The sim's whole guard, exposed rather than
   *  re-derived, so the menu gates and explains the instruction exactly as the sim would refuse
   *  it — an aircraft that cannot be hurried is the signal to send the other one around. */
  canExpedite: boolean
  /** Running its current clearance at more than a normal taxi speed. Spent by the next
   *  clearance of any kind — an instruction to hurry applies to the movement it was given for,
   *  so anything that sets a new speed ends it. Separation still caps it: hurrying is not
   *  permission to run into anyone. */
  expedite: boolean
  /** The charted hot spot this aircraft is currently inside, or null. Inside one, traffic is
   *  called as converging while it is still a few hundred feet apart — a hot spot is somewhere
   *  the field's own diagram says to watch harder, and watching harder is all the sim can do
   *  with that. */
  hotspot: string | null
  /** Callsign of the traffic this aircraft has been told to give way to, or null. */
  giveWayTo: string | null
  /** Designator of the stand this aircraft is holding for because someone is still on it, or
   *  null. It has a good clearance — it just cannot have the gate yet. */
  waitingForStand: string | null
  /** An inbound arrival whose destination stand is already occupied by someone else: a gate
   *  conflict that has not happened yet. True from the moment it appears on final, so it can be
   *  acted on — move the aircraft on the stand, or reassign — long before the arrival gets
   *  there and ends up holding on the alley. {@link waitingForStand} is the same conflict once
   *  it has actually bitten. */
  gateBlocked: boolean
  /** Assigned transponder (beacon) code once IFR clearance is delivered, or null. Note this is
   *  the code the *aircraft is squawking* — if the pilot misheard the clearance, it is not the
   *  code the controller issued. Comparing it against the transcript is the game. */
  squawk: string | null
  /** At least one instruction has been transmitted to this aircraft, so "say again" has
   *  something to repeat. Says nothing about whether it was read back correctly. */
  hasInstruction: boolean
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
  /** Radio transcript, oldest first, capped at `COMMS_LOG_LIMIT`. */
  comms: readonly Transmission[]
  /** Clearances a pilot has read back incorrectly this session. */
  readbackErrors: number
  /** How many of those the controller caught with a "say again" before they mattered. */
  readbackCaught: number
  /** Runway conflicts developing right now, most severe first. Empty is the normal case. */
  incursions: readonly RunwayIncursion[]
  /** Charted hot spots holding two or more aircraft right now, in charted order. One aircraft
   *  in a hot spot is just an aircraft; two is the situation the chart is warning about. */
  busyHotspots: readonly string[]
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
  /** Runway turnoffs this arrival could still be assigned: ahead of it, and reachable at its
   *  current speed. Empty for anything that isn't landing. */
  exitOptions(aircraftId: string): RunwayExit[]
  /** The runway direction in use, or null when the sim has no configuration. */
  runway(): ActiveRunway | null
  /** Where arrivals are established on final, derived from the active runway. */
  approach(): ApproachConfig | null
  /** Change the active runway direction — the airport's configuration. Refused while anything
   *  is committed to the current runway (on it, or on short final above it). On success every
   *  arrival still on final goes around and re-establishes on the new approach, and departures
   *  yet to roll are retargeted to the new departure end. */
  setRunway(next: ActiveRunway): DispatchResult
  /** Insert an aircraft at runtime (dev/admin sandbox); returns its id. */
  add(init: AircraftInit): string
  /** Remove an aircraft by id; returns whether one was removed. */
  remove(aircraftId: string): boolean
  /** Remove every aircraft from the surface. */
  clear(): void
  /** Whether an aircraft is physically parked on this stand right now. */
  standOccupied(ref: string): boolean
  /** Stands this arrival could be sent to instead: neither occupied nor already assigned to
   *  someone else, nearest first. Empty for anything that isn't an arrival. */
  standOptions(aircraftId: string): StandOption[]
  /** The ways this aircraft could be pushed back off its stand (empty if it can't be pushed).
   *  Every stand has two, so this is a real choice: the direction it ends up facing is the
   *  direction it must taxi off in, since it cannot turn around on the alley. */
  pushbackOptions(aircraftId: string): PushbackOption[]
}
