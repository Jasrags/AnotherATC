import { createRng, type Rng } from '../random'
import type { Hotspot, Point } from '../world/types'
import type {
  AircraftDebug,
  ControllerPosition,
  PushbackOption,
  StandOption,
  DispatchResult,
  GroundAircraft,
  GroundCommand,
  GroundIntent,
  GroundSim,
  GroundSnapshot,
  GroundStatus,
  WakeCategory,
} from './types'
import { edgeKey, type TaxiGraph } from './taxiGraph'
import { distToSegment, findStand, type Stand } from './stands'
import { MAX_TURN_DEG } from './taxiGraph'
import {
  clockTime,
  COMMS_LOG_LIMIT,
  misheardSquawk,
  negative,
  phraseFor,
  type PhraseContext,
  type Transmission,
  type TransmissionFrom,
} from './comms'
import { wakeSeparationSec, WAKE_TIME_SCALE } from './wake'
import { lookupAircraftType } from './aircraftTypes'
import { onRunway, runwayIdAt, splitRouteAtRunway, type RunwayGuard } from './runwayGuard'
import { detectIncursions, type RunwayIncursion, type RunwayUse } from './incursion'
import { busyHotspots, hotspotAt } from './hotspot'
import { detectConverging, type ConflictView, type TrafficConflict } from './converging'
import {
  finalFix,
  glideAltitudeFt,
  landingEnd,
  reciprocalIdent,
  takeoffEnd,
  FINAL_APPROACH_NM,
  SHORT_FINAL_NM,
  type ActiveRunway,
  type RunwayInteractionKind,
  type RunwaysInteract,
  type RunwayCrossing,
} from './runway'
import {
  brakeRateFor,
  buildRunwayExits,
  chooseExit,
  MAX_BRAKE_KT_S,
  MIN_BRAKE_KT_S,
  cannotMake,
  profileCap,
  requiredBrakeRate,
  turnSpeedLimits,
  type RunwayExit,
} from './runwayExits'

/** Initial definition of one aircraft: a route (nm waypoints) taxied at a target speed. */
export interface AircraftInit {
  id: string
  callsign: string
  type: string
  wake: WakeCategory
  path: readonly Point[]
  targetSpeed: number
  heading?: number
  /** Start airborne on final approach: `path` runs from the final fix to the landing
   *  threshold (its last point), flown at `targetSpeed`. Arrivals only. */
  airborne?: boolean
  intent?: GroundIntent
  /** Where this aircraft ultimately wants to go (runway for departures, gate for arrivals). */
  goalPoint?: Point
  gate?: string
  /** Which traffic class this aircraft belongs to ({@link SpawnFleet.kind}). Decides what
   *  happens to it on stand — see {@link SpawnFleet.servicing}. Omitted for hand-authored
   *  aircraft and the dev sandbox, which fall back to the field's own profile. */
  fleet?: string
}

/** A gate/stand the spawner can use. */
export interface GateSlot {
  ref: string
  /** Where the nose stops — the end of the stand's lead-in line, not the gate label point. */
  point: Point
  /** Which way the aircraft faces when parked. Without it a parked aircraft points north and
   *  the pushback that follows looks like it is being dragged sideways off the stand. */
  headingDeg?: number
}

/** Final-approach geometry: arrivals appear airborne at `fix` (on the runway centerline
 *  extended) and fly the straight final in to `threshold` (the landing threshold). */
export interface ApproachConfig {
  fix: Point
  threshold: Point
}

/** Deterministic traffic generation. */
/**
 * A class of traffic the field generates: who they are, where they park, and how much of the
 * flow they are.
 *
 * Fleets exist because **what an aircraft is decides where it parks**, and the two cannot be
 * chosen independently — a 737 does not park on a freight apron and a Cessna does not take a
 * jet bridge. Weighting is the other half: a field's cargo ramp may hold a third of its stands
 * and see a twentieth of its movements, so stand count is not traffic share. Which traffic
 * belongs where is a scenario question, which is why it is stated here rather than derived
 * from the geometry.
 */
export interface SpawnFleet {
  /** What this traffic is — "airline", "cargo", "ga". */
  kind: string
  /** Relative share of spawn attempts. Summed across fleets, so they need not total anything. */
  weight: number
  /** The stands this fleet parks on. */
  gates: readonly GateSlot[]
  /** The ICAO type designators this fleet flies — the airframes {@link identity} draws from.
   *  Exposed (not just captured inside the closure) so a consumer can enumerate what a field's
   *  fleets contain: the dev sandbox lists these to let a tester pick a specific type to spawn. */
  types: readonly string[]
  /** Produces a callsign/type for one aircraft of this fleet. */
  identity: (rng: Rng) => { callsign: string; type: string; wake: WakeCategory }
  /**
   * What this fleet's aircraft need done before they can push back. Omit to use the field's
   * own {@link GroundSimOptions.servicing}.
   *
   * Here rather than on the field because it is a fact about the *aircraft*, not the airport:
   * a light single needs fuel and nothing else at any airport in the world, and a freighter is
   * loading freight wherever it is parked. One global profile made a Cessna wait out an airline
   * catering truck — the last place "what an aircraft is decides what happens to it" was not
   * honoured, having already decided where it parks and what it does to the wake matrix.
   */
  servicing?: ServicingConfig
}

export interface SpawnConfig {
  /** The traffic classes this field generates. Order is meaningful only for the initial fill. */
  fleets: readonly SpawnFleet[]
  /** Where departures head to leave the surface (a runway point). */
  departureTarget: Point
  /** Where arrivals appear: established on final, inbound to the landing threshold. */
  approach: ApproachConfig
  intervalSec: number
  maxAircraft: number
  seed: number
}

/** One parallel ground service and how long it takes (game seconds). */
export interface ServiceSpec {
  kind: string
  sec: number
}

/**
 * Wheels-up time windows, as a property of the field.
 *
 * The lead is airfield-specific and cannot sensibly be an engine constant: a slot has to clear
 * the field's own taxi time, and "eight minutes out" is generous at a field you cross in three
 * and unmakeable at one you cross in twelve. Measure the field (clearance → hold-short line)
 * and set the lead above it — a slot inside the taxi time is not a constraint, it is a
 * guaranteed miss. The *window* and the penalty are not here for the same reason in reverse:
 * they are the flow system's rules and do not vary by airport.
 */
export interface SlotConfig {
  /** Share of departures whose clearance carries an EDCT, 0–1. */
  rate: number
  /** How far out (s) a slot is issued — drawn between these. */
  leadMinSec: number
  leadMaxSec: number
}

/** Ground-servicing model: the parallel services a parked departure must complete before it
 *  may push back (fueling is usually the long pole). Omit to disable servicing entirely. */
export interface ServicingConfig {
  services: readonly ServiceSpec[]
}

export interface GroundSimOptions {
  graph?: TaxiGraph
  guard?: RunwayGuard
  /** Charted incursion hot spots. Omit for a field whose diagram publishes none — the sim then
   *  behaves exactly as it did before they existed. */
  hotspots?: readonly Hotspot[]
  spawn?: SpawnConfig
  servicing?: ServicingConfig
  /** Published controller frequencies, quoted in handoff phraseology ("contact tower 118.3").
   *  Omit and the transcript simply says "contact tower". */
  frequencies?: { ground: string; tower: string }
  /** Stand geometry: the painted lead-in line for each gate. Omit and an aircraft parks at the
   *  bare gate point, which is what makes an arrival cut across the apron and a pushback shove
   *  off toward whatever node happens to be nearest. */
  stands?: readonly Stand[]
  /** Turn arrivals round instead of despawning them: on reaching its stand an arrival is
   *  counted, then becomes a departure at that same gate. Omit (the default) and an arrival
   *  clears the field when it parks, which is what every test written before this assumes. */
  turnaround?: boolean
  /** Read-back errors: with what probability a pilot mishears a clearance, and the seed that
   *  makes it reproducible. Omit (the default) and every read-back is correct — which is why
   *  every test written before this mechanic still holds. */
  readback?: { errorRate: number; seed: number }
  /** Wheels-up time windows: how often a departure's IFR clearance carries an EDCT, how far out
   *  this field's slots are issued, and the seed that makes it reproducible. Omit and no flight
   *  is slot-constrained. See docs/atc-flight-cycle.md for the window and the penalty, which are
   *  the flow system's rules rather than the field's. */
  slots?: SlotConfig & { seed: number }
  /** The runway direction in use. Supplies the real landing threshold (which is *not* the end
   *  of the pavement where the threshold is displaced) and the far end a takeoff rolls toward,
   *  instead of guessing both from the polyline endpoints. Sugar for a one-runway `runways`. */
  runway?: ActiveRunway
  /** The active runway directions when more than one runway is in use at once — at most one
   *  direction per physical runway (docs/atc-multi-runway.md §5). A single-runway field passes
   *  `runway` instead; this is its generalisation, and the two are mutually exclusive. */
  runways?: readonly ActiveRunway[]
  /** How this field couples its runways (docs/atc-multi-runway.md §6): whether traffic on one
   *  runway is relevant to a clearance on another, and why. Omit for independent runways — every
   *  runway minds only its own traffic, which is every single-runway field and any multi-runway
   *  field that has not stated a dependency. KBUR's crossing and KOAK's parallels plug in here. */
  runwaysInteract?: RunwaysInteract
  /** Where coupled runways physically cross. With this, the occupancy coupling is refined by
   *  position: a departure or rollout on one runway stops holding the other once it is past the
   *  intersection, instead of for its whole roll. Omit to keep the coarse boolean coupling. */
  runwayCrossings?: readonly RunwayCrossing[]
}

// ─── Wheels-up time windows (EDCT) ───────────────────────────────────────────
// How far out a slot is issued is *the field's* number — it has to clear that field's taxi
// time, which is why the lead comes in on the airport bundle rather than living here. What is
// here is the part that is not the field's: the compliance window and what a miss costs are
// flow-management rules, the same at every airport the flow system touches.
/** How early, and how late (s), a takeoff clearance still meets the slot. Narrow on purpose:
 *  a window wide enough to hit by accident is not a constraint. `EARLY` is exported because a
 *  UI counting down to the window has to count to the same instant the sim starts accepting the
 *  clearance — restating the number there would let a countdown reach zero on a button that is
 *  still refused. */
export const EDCT_EARLY_SEC = 120
const EDCT_LATE_SEC = 120
/** A missed slot is re-issued this far out (s) — the negotiation, as a penalty. */
const EDCT_PENALTY_MIN_SEC = 6 * 60
const EDCT_PENALTY_MAX_SEC = 10 * 60

const TAXI_ACCEL = 4
/** How far (nm) from the taxi network a requested destination may be and still be snapped onto
 *  it. Roughly 1,500 ft: wider than any stand's lead-in, narrow enough that a point out over the
 *  bay is not quietly turned into a clearance. See {@link withinSnap}. */
const MAX_GOAL_SNAP_NM = 0.25
const TAXI_SPEED_KT = 15
/** Taxi speed (kt) under an "expedite". Faster, but still a speed a jet can hold on pavement
 *  and still subject to every separation cap — hurrying is not permission to run into anyone. */
const EXPEDITE_SPEED_KT = 25
/** Pushback creep speed (kt) — a tug easing the aircraft off the stand. */
const PUSHBACK_SPEED_KT = 5
/**
 * How far short of the lead-in an aircraft waiting for an occupied stand stops (nm ≈ 185 m).
 *
 * Not a cosmetic margin. Holding right at the paint deadlocks the pair: the aircraft on the
 * stand pushes back down that same lead-in and stops nose-to-nose with the one waiting for it,
 * so it can never vacate and the waiting aircraft can never be let in. The hold has to leave the
 * whole lead-in plus room for the push and the turn onto the alley.
 */
const STAND_HOLD_NM = 0.1

/** How fast the tug swings the nose round during a push (deg/s), so the aircraft ends the
 *  push already facing the way it will taxi rather than snapping round at the last moment. */
const PUSH_TURN_RATE_DEG_S = 6

/** Speed (kt) along a stand's lead-in line. An aircraft is marshalled onto a stand at a walking
 *  pace, not at taxi speed — and the line is short enough that arriving at 15 kt means stopping
 *  dead on the mark rather than easing onto it. */
const STAND_SPEED_KT = 5
/** Takeoff roll: full-power acceleration (kt/s) up to the liftoff speed (kt). */
const TAKEOFF_ACCEL = 12
const TAKEOFF_SPEED_KT = 140
/** Runway (nm) a departure needs ahead of it to get airborne, straight from this sim's own
 *  takeoff physics: v² / (2·a) with v in kt and distance in nm. Anything less and the roll would
 *  run off the end — which is exactly what happened when an aircraft at the *wrong* end of the
 *  runway was cleared: the far end was right beside it, so it drove onto the grass. */
const MIN_TAKEOFF_RUN_NM = (TAKEOFF_SPEED_KT * TAKEOFF_SPEED_KT) / (7200 * TAKEOFF_ACCEL)
/** Groundspeed (kt) at which a departure has "rotated" — effectively airborne, so it no longer
 *  blocks the next departure's takeoff clearance (anticipated separation).
 *  SAFETY NOTE: clearing #2 once #1 passes this speed is collision-free only because takeoff
 *  acceleration is uniform across all aircraft (TAKEOFF_ACCEL) — #2 is then a pure time-shifted
 *  replay of #1, so the gap can only grow. If per-type/wake-category acceleration is ever added,
 *  a slower-accelerating leader followed by a faster follower could close the gap; revisit this
 *  gate (add a distance floor) then, since detectConflicts() excludes departing pairs. */
const ROTATE_KT = 120

/** How far past a runway crossing (nm ≈ 240 ft) a moving aircraft must be before it stops holding
 *  the intersecting runway — its length plus the crosser's width plus a margin, so "past" means
 *  genuinely clear of the intersection, not merely across the centreline. */
const CROSSING_CLEARED_NM = 0.04

// ─── Final approach & landing (Tower) ────────────────────────────────────────
/** Glide path (deg) assumed when no runway configuration supplies a real one. */
const DEFAULT_GLIDE_DEG = 3
/** Approach speed (kt) flown down the final, and the speed at touchdown. Exported so a
 *  hand-authored arrival (a scenario, or the dev sandbox) flies the same profile as a
 *  spawned one — it is a parameter, not a rule the caller could get subtly wrong. */
export const APPROACH_SPEED_KT = 140
/** Braking deceleration (kt/s) used when there is no charted exit to aim at (no routing graph,
 *  or nothing reachable) — the aircraft just brakes to taxi speed on the centerline. With an
 *  exit assigned the rate is solved per rollout instead, so it arrives at the turnoff at the
 *  turnoff's speed (see runwayExits.ts). */
const ROLLOUT_DECEL = MAX_BRAKE_KT_S
/** How far ahead of the perpendicular foot the generated fillet aims, clamped to this range. A
 *  line-up close to the stripe still needs room to arc onto it (the floor); one holding far off
 *  must not be carried a long way down the runway to line up (the ceiling) — a real hold-short is
 *  a plane's width off, so the ceiling only bites the artificially wide synthetic fixtures. */
const LINEUP_FILLET_MIN_LEAD_NM = 0.025
const LINEUP_FILLET_MAX_LEAD_NM = 0.035
/** Length (nm) of the final straight step that pins the line-up's last segment exactly onto the
 *  takeoff direction. Only its direction matters, so it is kept short to barely lengthen the roll-
 *  in — a longer one carries the aircraft needlessly down the runway before it stops. */
const LINEUP_FILLET_ALIGN_NM = 0.012
/** Cubic-Bézier control-handle length as a fraction of the start→entry chord. ~0.4 gives a gentle,
 *  full turn; higher bulges the curve, lower tightens it toward a straight cut. */
const LINEUP_FILLET_TENSION = 0.4
/** How many segments to sample the fillet into. Enough that the drawn path reads as a curve and
 *  the aircraft's turn-rate limiter has vertices close enough to track smoothly. */
const LINEUP_FILLET_SAMPLES = 12
/** How close (nm) counts as reaching a gate. */
const GATE_EPS = 0.02
/** Seconds an arrival dwells at the gate before it clears the stand. */
const GATE_DWELL_SEC = 8

// ─── Separation ─────────────────────────────────────────────────────────────
/** How close (nm ≈ 240 ft) another aircraft has to be to a turnoff before a landing may no
 *  longer be planned onto it: a plane's length, plus room to stop behind it. */
const EXIT_BLOCKED_NM = 0.04
/** How far ahead (nm) an aircraft watches for traffic. Sized for taxi speeds: 0.06 nm is ~9 s
 *  at 25 kt but ~1.5 s at 140 kt, which is why a landing rollout is kept out of an occupied
 *  turnoff at planning time rather than relying on this to stop it. */
const LOOK_AHEAD_NM = 0.06
/** Half-width (nm) of the path corridor: traffic outside it is off to the side. */
const CORRIDOR_HALF_NM = 0.012
/** Minimum gap (nm) an aircraft keeps behind traffic ahead. */
const MIN_GAP_NM = 0.022
/** Heading difference (deg) under which traffic ahead counts as same-direction (a leader). */
const SAME_DIR_DEG = 60
/** Groundspeed (kt) above which an aircraft counts as "rolling" for right-of-way. */
const ROLLING_KT = 1

// ─── Segment reservation (hold-at-junction) ──────────────────────────────────
/** Only reserve/hold for a contested edge whose entry node is within this range (nm). */
const RESERVE_HORIZON_NM = 0.12
/** Stop this far (nm) short of the contested edge's mouth, leaving the junction clear. */
const HOLD_MARGIN_NM = MIN_GAP_NM
/** Braking ramp (nm) used to decelerate to a stop at the hold point. */
const HOLD_RAMP_NM = 0.03

// ─── Parallel-taxiway diversion ──────────────────────────────────────────────
/** Seconds an aircraft must sit reservation-held before it reroutes around the block. */
const DIVERT_AFTER_SEC = 6
/** Accept a diversion only if the detour is at most this multiple of the direct route.
 *  A modest parallel taxiway diverts; a long way around is worse than just waiting. */
const DIVERSION_COST_FACTOR = 2

// ─── Give way (manual, to a specific aircraft) ────────────────────────────────
/** Hold for the named traffic while it is within this range (nm) and not yet behind us. */
const GIVEWAY_WATCH_NM = 0.1
/** The traffic counts as "passed" once it is this far (nm) behind our nose. */
const GIVEWAY_CLEARED_NM = 0.02
/** Forget the give-way if the traffic wanders this far (nm) away without ever passing. */
const GIVEWAY_FORGET_NM = 0.35

/** Smallest absolute heading difference in degrees (0–180). */
function angleDelta(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180)
}

function bearing(ax: number, ay: number, bx: number, by: number): number {
  return (Math.atan2(bx - ax, by - ay) * 180) / Math.PI
}
function normalizeDeg(d: number): number {
  return ((d % 360) + 360) % 360
}
function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}
/** Signed area of triangle abc — its sign says which side of line ab point c is on. */
function ccw(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}
function pointSegDist(p: Point, a: Point, b: Point): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  let t = l2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy))
}

/**
 * Total right-of-way order between two aircraft: returns `true` when `a` goes first.
 * A rolling aircraft outranks a stopped one (don't halt a moving jet for a stationary
 * one); ties break on a stable id. Because this is a *total* order, of any two aircraft
 * exactly one yields — never both — which is precisely what stops a head-on or an
 * intersection from locking up when each aircraft is waiting on the other.
 */
function outranks(a: Internal, b: Internal): boolean {
  const aRolling = a.groundspeed > ROLLING_KT
  const bRolling = b.groundspeed > ROLLING_KT
  if (aRolling !== bRolling) return aRolling
  return a.id < b.id
}

// `status` is derived at snapshot time, so it is not stored here.
interface Internal
  extends Omit<
    GroundAircraft,
    | 'status'
    | 'holdingForTakeoff'
    | 'wakeHoldSec'
    | 'serviceSec'
    | 'onRunway'
    | 'blocksTakeoff'
    | 'onShortFinal'
    // Derived at snapshot time from the route position, not stored twice.
    | 'canExpedite'
    | 'canHoldShort'
    // Derived at snapshot time from the target speed, which is what it means.
    | 'expedite'
    | 'finalNm'
    | 'exitRef'
    | 'vacated'
    | 'handoffPending'
    // Derived at snapshot time from `lastClearance`, not stored twice.
    | 'hasInstruction'
    // Derived at snapshot time from the stand's occupancy.
    | 'waitingForStand'
    | 'gateBlocked'
  > {
  path: readonly Point[]
  leg: number
  targetSpeed: number
  goalPoint: Point | null
  /** Countdown once parked at the destination gate (<0 = not yet arrived). */
  dwell: number
  /** Route beyond a hold-short line, released by a crossRunway clearance. */
  held: Point[] | null
  /** Backing off the stand onto the taxilane (nose trailing) until it reaches the alley. */
  pushingBack: boolean
  /** Id of traffic this aircraft has been told to give way to (holds until it passes), or null. */
  giveWayTo: string | null
  /** Transponder code assigned when IFR clearance is delivered (departures), or null. */
  squawk: string | null
  /** Rolling for takeoff down the runway toward the far end (after a takeoff clearance). */
  departing: boolean
  /** Lined up on the runway centerline awaiting takeoff clearance (Tower's "line up and wait"). */
  lineUpWait: boolean
  /** Id of the landing aircraft a *conditional* line-up is waiting for, or null. The clearance
   *  is issued now and applied later, so this is a commitment the controller has made and the
   *  sim has not yet acted on — see {@link resolveConditionalLineUp}. */
  lineUpBehind: string | null
  /** Flying the final approach (altitude > 0, not yet touched down). */
  airborne: boolean
  /** Holds a landing clearance — will touch down rather than go around at the threshold. */
  clearedToLand: boolean
  /** Decelerating on the runway after touchdown, before the Tower→Ground handoff. */
  rollingOut: boolean
  /** The landing threshold this arrival's final is flown to (null unless it has a final). */
  threshold: Point | null
  /** Length (nm) of the full final, used to derive the descent profile. */
  finalLenNm: number
  /** Height (ft) at the final fix, from the runway's published glide path. */
  finalAltFt: number
  /** The turnoff this arrival is planning for / rolling out to, or null when none applies. */
  exit: RunwayExit | null
  /** Turnoff the controller assigned by designator; overrides the default choice. */
  assignedExitRef: string | null
  /** Deceleration (kt/s) for the current rollout, solved so every corner ahead is met at its
   *  own speed limit — not just the turnoff entrance. */
  brakeRate: number
  /** Speed limit (kt) at each vertex of the current rollout path, from the turn geometry. */
  speedLimits: number[]
  /** Fully clear of the runway — past the turnoff's hold-short point, not merely off the
   *  pavement band. This is the "vacated" a controller means, and it releases the runway. */
  vacated: boolean
  /** Tower has issued the frequency change; it takes effect the moment the aircraft vacates
   *  ("when vacated, contact ground"). The aircraft never switches on its own. */
  groundPending: boolean
  /** Parallel ground services still counting down while parked at the gate (empty when none). */
  services: { kind: string; total: number; remaining: number }[]
  /** The traffic class this aircraft belongs to ({@link SpawnFleet.kind}), or null when it came
   *  from no fleet. Internal for now: it decides what happens to the aircraft on stand, and
   *  nothing outside the sim has asked which fleet a strip belongs to. */
  fleet: string | null
  /** Undirected edge (key) the reservation is currently making this aircraft hold short of, or null. */
  blockedEdge: string | null
  /** Id of the aircraft it is being held *for* — the contender that won the edge. Named as well
   *  as counted because a hold resolves that pair and no other: see `ConflictView.yieldingTo`. */
  blockedBy: string | null
  /** Seconds spent continuously reservation-held — once past a threshold, we try to divert. */
  heldSec: number
  /** Seconds spent continuously stopped with nothing left to run — see
   *  {@link GroundAircraft.awaitingSec}, which is this rounded down to whole seconds. */
  awaitingSec: number
  /** Contested edges a diversion has already routed this aircraft around (kept off reroutes). */
  avoidEdges: Set<string>
  /** Blocked edges we already tried and failed to divert around (skip recompute until recleared). */
  divertTried: Set<string>
  /** Heading the tug is swinging the nose toward during a push, or null for a straight push. */
  pushFacing: number | null
  /** Compass point of that heading, for the transcript. */
  pushFacingLabel: string | null
  /** A direction the aircraft is committed to while stationary — it has just been pushed back
   *  facing this way and cannot turn round on the alley. Cleared once it is taxiing, after
   *  which its own heading serves the same purpose. */
  facingCommitted: number | null
  /** Cleared for takeoff while still holding short: taxi into position first, then roll.
   *  The roll begins on its own once the aircraft is established on the centerline. */
  rollWhenLinedUp: boolean
  /** Permission to be on the runway surface without a takeoff or landing clearance: a crossing
   *  clearance, or a rollout that has been released to taxi off. `'issued'` until the aircraft
   *  actually reaches the pavement, `'on'` while it is there, then dropped — so the permission
   *  is spent by the movement it was given for and a second, uncleared entry is an incursion.
   *
   *  The invariant, because a stale value here would silently mask a real incursion: it is
   *  *granted* only by `crossRunway` and by `handOffToGround` (a landing still clearing the
   *  pavement), and *revoked* by the latch in {@link detectRunwayIncursions} when the aircraft
   *  leaves the runway, by `applyRoute` when a new clearance supersedes an unused one, and by
   *  `turnRound`. A new way of getting an aircraft onto the runway must grant it explicitly —
   *  do not rely on some other path having left the right value behind. */
  runwayAuth: 'issued' | 'on' | null
  /** On the runway in a way {@link detectIncursions} has flagged — a red ring, not a refusal. */
  incursion: boolean
  /** The last clearance transmitted to this aircraft — what "say again" repeats. */
  lastClearance: GroundCommand | null
  /**
   * The beacon code the controller *issued*, as against {@link squawk}, which is the code the
   * aircraft is actually squawking. The two differ exactly when a read-back was misheard and
   * never verified.
   *
   * Durable, and deliberately not tied to the last clearance: a transponder set to the wrong
   * code stays wrong through every instruction that follows, because nothing in a pushback or
   * a taxi clearance touches it. The mishearing used to be forgotten the moment any other
   * clearance was issued, which made an uncaught error both untraceable and uncorrectable —
   * so it could never cost anything, and the whole mechanic was decorative.
   */
  issuedSquawk: string | null
  /** Sim time (s) this departure is required to be airborne at, or null when unconstrained.
   *  Re-issued further out when the window is missed — the slot is a standing constraint on the
   *  flight, not a one-shot that expires. */
  edctSec: number | null
}

/**
 * A deterministic surface-movement simulation with intent-driven traffic:
 * departures taxi to the runway and leave; arrivals taxi to a gate and clear.
 * A {@link SpawnConfig} feeds new traffic over time. Internal state is mutated
 * in place each tick; {@link GroundSim.snapshot} hands out fresh immutable objects.
 */
export function createGroundSim(inits: readonly AircraftInit[], opts: GroundSimOptions = {}): GroundSim {
  const { graph, guard, spawn, servicing, frequencies, readback, slots, turnaround } = opts
  const hotspots = opts.hotspots ?? []
  const stands = opts.stands ?? []
  /**
   * The active runway directions, at most one per physical runway (docs/atc-multi-runway.md §5).
   * A single-runway field has exactly one. Each is tagged with the physical runway id it uses (the
   * guard's answer for its threshold), so an aircraft's runway can be matched to its active
   * direction. Mutable: an airport changes configuration.
   */
  const physicalIdOf = (dir: ActiveRunway): string => {
    if (guard) {
      const id = runwayIdAt(dir.threshold, guard)
      if (id !== null) return id
    }
    // No guard geometry to name the runway: group the two reciprocal directions (09/27) under one
    // canonical id, so a direction change is a swap on one runway, not the birth of a second.
    return [dir.ident, reciprocalIdent(dir.ident)].sort()[0]!
  }
  let active: { dir: ActiveRunway; id: string }[] = (
    opts.runways ?? (opts.runway ? [opts.runway] : [])
  ).map((dir) => ({ dir, id: physicalIdOf(dir) }))
  /** The primary active runway — the config-level default for approach, glide path and spawn.
   *  A single-runway field has one; on a multi-runway field these are per-runway concerns that
   *  arrive with per-runway spawning, so the first active runway stands in until then. Kept in
   *  sync with `active` (see setRunway) so the many config-level reads below need no change. */
  let runway: ActiveRunway | undefined = active[0]?.dir
  /** How this field couples its runways; independent by default (docs/atc-multi-runway.md §6). */
  const runwaysInteract: RunwaysInteract = opts.runwaysInteract ?? (() => false)
  /** Where coupled runways cross, for the position-aware refinement of the occupancy coupling. */
  const runwayCrossings: readonly RunwayCrossing[] = opts.runwayCrossings ?? []
  /** Whether traffic on runway `other` bears on a clearance protecting runway `mine`, for `kind`:
   *  the same runway always does, and a coupled pair does when the field says so. The single
   *  choke point every per-runway gate goes through, so "same runway, or interacting" is stated
   *  once. Null on either side means unresolved — treated as unrelated (the caller field-wides). */
  const runwaysRelated = (
    mine: string | null,
    other: string | null,
    kind: RunwayInteractionKind,
  ): boolean => mine !== null && other !== null && (mine === other || runwaysInteract(mine, other, kind))
  /** The active direction on the runway `ac` is using — its takeoff/landing geometry — matched by
   *  the aircraft's own runway id, falling back to the single active runway. */
  const activeRunwayFor = (ac: Internal): ActiveRunway | undefined => {
    const id = targetRunwayId(ac)
    const hit = id !== null ? active.find((a) => a.id === id) : undefined
    return hit?.dir ?? (active.length === 1 ? active[0]!.dir : undefined)
  }
  /** The active runway an arrival established on `thr` is landing on — matched by threshold point,
   *  which the spawner sets to the runway's own. For resolving per-runway facts (the glide path)
   *  at construction, before the aircraft is in the fleet for {@link activeRunwayFor}. Falls back
   *  to the primary runway for a threshold that matches none (a dev/hand-authored arrival). */
  const runwayAtThreshold = (thr: Point | null): ActiveRunway | undefined => {
    if (!thr) return runway
    return active.find((a) => a.dir.threshold[0] === thr[0] && a.dir.threshold[1] === thr[1])?.dir ?? runway
  }
  /** Where arrivals are established, derived from the active runway when there is one. */
  const approachNow = (): ApproachConfig | null =>
    runway
      ? { fix: finalFix(runway, FINAL_APPROACH_NM), threshold: runway.threshold }
      : (spawn?.approach ?? null)
  let time = 0
  let departed = 0
  let arrived = 0
  /** Runway conflicts as of the last step, recomputed there rather than per snapshot — the
   *  canvas snapshots every frame and this is a fleet-squared scan. */
  let incursions: readonly RunwayIncursion[] = []
  /** Taxi conflicts as of the last step — happening and developing, worst first. */
  let conflicts: readonly TrafficConflict[] = []
  /** The most recent departure to begin its takeoff roll on each runway — the wake-separation
   *  leader, keyed by runway id. Per-runway because wake is a same-runway constraint: a Heavy off
   *  one runway does not gate a departure on another (docs/atc-multi-runway.md §4). A single-runway
   *  field has one key, so this is exactly the old single leader. */
  const lastDepartureByRunway = new Map<string, { wake: WakeCategory; atTime: number }>()
  let seq = 0
  const spawnRng = spawn ? createRng(spawn.seed) : null
  /** Multiplier on the field's configured traffic — see {@link GroundSim.setTrafficRate}. */
  let trafficRate = 1
  /** Seconds between spawn attempts at the current rate; Infinity when there is no traffic. */
  const spawnIntervalSec = (): number =>
    spawn && trafficRate > 0 ? spawn.intervalSec / trafficRate : Infinity
  /** Cap on simultaneous aircraft at the current rate. Scaling the cap as well as the interval
   *  is what makes "less traffic" a smaller field rather than the same field filled slower.
   *  Rate 0 is a cap of 0 in its own right: "no traffic" must not depend on the interval being
   *  the only thing that says so. */
  const spawnCap = (): number =>
    spawn && trafficRate > 0 ? Math.max(1, Math.round(spawn.maxAircraft * trafficRate)) : 0
  let nextSpawnAt = spawnIntervalSec()

  // Deterministic beacon-code assignment for IFR clearances (4-digit octal).
  let squawkSeq = 0
  const nextSquawk = (): string => {
    const code = (0o4201 + squawkSeq * 0o27) % 0o10000
    squawkSeq += 1
    return code.toString(8).padStart(4, '0')
  }

  // ─── Communications log ────────────────────────────────────────────────────
  // The transcript is written by the sim, not the UI, so it can only ever say what actually
  // happened: a call is logged at the moment the command is applied, never when it is offered
  // and never when it is refused (a refused clearance was never transmitted).
  const comms: Transmission[] = []
  let commsSeq = 0
  /** Handed out by `snapshot()`. Rebuilt only when something is said, so the per-frame
   *  snapshot doesn't copy the whole transcript for a log that usually hasn't changed. */
  let commsView: readonly Transmission[] = []
  let commsDirty = false
  function transmit(from: TransmissionFrom, position: ControllerPosition, ac: Internal, text: string): void {
    commsSeq += 1
    comms.push({ seq: commsSeq, time, from, position, aircraftId: ac.id, callsign: ac.callsign, text })
    if (comms.length > COMMS_LOG_LIMIT) comms.splice(0, comms.length - COMMS_LOG_LIMIT)
    commsDirty = true
  }

  /** The transcript as an immutable view, rebuilt only when something has been said since the
   *  last read — one exchange is two or three `transmit` calls, and a snapshot is taken far
   *  more often than a clearance is issued. */
  function commsSnapshot(): readonly Transmission[] {
    if (commsDirty) {
      commsView = [...comms]
      commsDirty = false
    }
    return commsView
  }

  /** The runway this aircraft is using, spoken — its own, not the primary, so with two runways
   *  active a 15 departure is cleared for "runway 15" and an 08 one for "runway 8". Falls back to
   *  the primary when the aircraft resolves to none (docs/atc-multi-runway.md §5). */
  const runwayIdentFor = (ac: Internal): string | null =>
    (activeRunwayFor(ac)?.ident ?? runway?.ident)?.replace(/^0/, '') ?? null

  function phraseContext(ac: Internal): PhraseContext {
    const rwy = runwayIdentFor(ac)
    return {
      callsign: ac.callsign,
      runway: rwy,
      squawk: ac.squawk,
      edct: ac.edctSec === null ? null : clockTime(ac.edctSec),
      // Something is landing on the runway this aircraft is being sent onto. FAA 7110.65 issues
      // the traffic with the instruction, and an aircraft told to enter an occupied runway is
      // owed the reason.
      landingTraffic: fleet.some((o) => o !== ac && o.rollingOut && onRunwayNow(o)),
      lineUpBehind: ac.lineUpBehind ? (find(ac.lineUpBehind)?.callsign ?? null) : null,
      taxiways: taxiwaysFor(ac),
      destination:
        ac.intent === 'departure' ? (rwy ? `runway ${rwy}` : null) : ac.gate ? `gate ${ac.gate}` : null,
      giveWayTo: ac.giveWayTo ? (find(ac.giveWayTo)?.callsign ?? null) : null,
      towerFreq: frequencies?.tower ?? null,
      groundFreq: frequencies?.ground ?? null,
      vacated: ac.rollingOut ? ac.vacated : true,
      pushFacing: ac.pushFacingLabel,
      position: ac.controlledBy,
      // A transit either way: holding short with a far side to reach, or already across and
      // being handed back. Keyed off the *destination* first — an aircraft whose goal is the
      // runway is departing, however far its route happens to be drawn past it — then the
      // route, then a crossing already under way. `rollingOut` is the landing case, which words
      // itself differently.
      crossing: onCrossing(ac),
      // The runway this aircraft's clearance stops short of, if any — the clause that makes a
      // taxi clearance readable back as the procedure requires.
      holdingShortOf: ac.held !== null ? rwy : null,
      holdReason: holdReasonFor(ac),
      onRunway: onRunwayNow(ac),
    }
  }

  // ─── Read-back verification ────────────────────────────────────────────────
  // A pilot who mishears a clearance *acts on what they read back* — which is why the read-back
  // exists in real ATC and why catching a wrong one is the controller's job. The clearance is
  // never withheld: it takes effect immediately, wrong. The only cue is the transcript, so
  // catching one is a judgement rather than a prompt, and "say again" is the catch.
  const readbackRng = readback ? createRng(readback.seed) : null
  let readbackErrors = 0
  let readbackCaught = 0

  // ─── Wheels-up time windows ────────────────────────────────────────────────
  // A slot is a promise made on the aircraft's behalf before it has moved, and everything
  // between here and the runway is the controller's problem. See docs/atc-flight-cycle.md.
  const slotRng = slots ? createRng(slots.seed) : null
  let slotsMet = 0
  let slotsMissed = 0

  /** A wheels-up time `lead` out from now, drawn on the slot stream. */
  function nextSlot(minSec: number, maxSec: number): number {
    const spread = Math.max(0, Math.round(maxSec - minSec))
    return time + minSec + (slotRng ? slotRng.int(0, spread) : 0)
  }

  /** Give this departure a slot, if the field issues them and this flight draws one. */
  function maybeSlot(ac: Internal): void {
    if (!slots || !slotRng || ac.intent !== 'departure') return
    if (slotRng.next() >= slots.rate) return
    ac.edctSec = nextSlot(slots.leadMinSec, slots.leadMaxSec)
  }

  /** Whether a takeoff clearance now would meet this aircraft's slot: inside the window, or
   *  unconstrained. `null` when there is no slot at all. */
  function slotState(ac: Internal): 'early' | 'open' | 'late' | null {
    if (ac.edctSec === null) return null
    if (time < ac.edctSec - EDCT_EARLY_SEC) return 'early'
    if (time > ac.edctSec + EDCT_LATE_SEC) return 'late'
    return 'open'
  }

  /** Corrupt what the pilot heard, saving the correct value for a later correction. Returns
   *  whether anything was misheard. Only clearances carrying a discrete value can be misheard;
   *  everything else is read back verbatim. */
  function maybeMishear(cmd: GroundCommand, ac: Internal): boolean {
    if (!readbackRng || !readback || cmd.type !== 'clearance' || !ac.squawk) return false
    if (readbackRng.next() >= readback.errorRate) return false
    const wrong = misheardSquawk(ac.squawk, readbackRng.next(), readbackRng.next())
    ac.squawk = wrong // `issuedSquawk` still holds what was said; the two now disagree
    readbackErrors += 1
    return true
  }

  /**
   * The sim has changed this aircraft's clearance state on its own — a go-around voids a
   * landing clearance, a handoff ends the last position's business with it — so there is no
   * longer a standing clearance to repeat. Without this, "say again" would re-transmit an
   * instruction the simulation has already retracted, and the transcript would assert
   * something the state contradicts. `only` limits the void to a specific command, for
   * clearances that expire on their own terms rather than being superseded.
   */
  function voidClearance(ac: Internal, only?: GroundCommand['type']): void {
    if (only && ac.lastClearance?.type !== only) return
    ac.lastClearance = null
  }

  /** Whether this aircraft is squawking a code nobody issued it. */
  function squawkUnverified(ac: Internal): boolean {
    return ac.issuedSquawk !== null && ac.squawk !== ac.issuedSquawk
  }

  /** Undo a misheard clearance: the aircraft sets what the controller actually said. */
  function correctMishearing(ac: Internal): boolean {
    if (!squawkUnverified(ac)) return false
    ac.squawk = ac.issuedSquawk
    readbackCaught += 1
    return true
  }

  /** The situational facts a clearance is worded against, captured *before* it is applied.
   *  A command that changes the very thing its phrasing describes — a handoff that ends the
   *  crossing it is announcing — would otherwise be worded from the state it just created. */
  function situationBefore(ac: Internal | undefined): Partial<PhraseContext> {
    if (!ac) return {}
    const { crossing, onRunway } = phraseContext(ac)
    return { crossing, onRunway }
  }

  /** Log the exchange for a command that was just applied. `position` and `before` are captured
   *  before the command ran, since a handoff changes the owner and the situation mid-command. */
  function logExchange(
    cmd: GroundCommand,
    ac: Internal,
    position: ControllerPosition,
    before: Partial<PhraseContext>,
  ): void {
    // The instruction is phrased from the state as issued; the read-back from the state as the
    // pilot heard it. When nothing is misheard the two are the same context.
    const ex = phraseFor(cmd, { ...phraseContext(ac), ...before })
    if (!ex) return
    // A new clearance supersedes the last one for the purposes of "say again", which repeats
    // what was said most recently. A wrong *code* is not superseded by anything — the
    // transponder is still set wrong — so it outlives this; see `issuedSquawk`.
    ac.lastClearance = cmd
    const readbackText = maybeMishear(cmd, ac)
      ? (phraseFor(cmd, { ...phraseContext(ac), ...before })?.readback ?? ex.readback)
      : ex.readback
    transmit('controller', position, ac, ex.instruction)
    transmit('pilot', position, ac, readbackText)
  }

  /** "Negative, …": repeat the last clearance, correctly. Never mishears — the point of a
   *  correction is that it lands. */
  function logCorrection(ac: Internal, position: ControllerPosition, verifiedCode: boolean): void {
    // Caught immediately, the correction is the clearance itself: "negative, cleared as filed,
    // squawk 4271" is what a controller says to a wrong read-back, and the repeat below carries
    // the code. Once anything else has been said, repeating *that* would put "negative, hold
    // position" in the log for an exchange that actually fixed a transponder — so the code gets
    // its own phrase. The transcript is the only record the controller has of either.
    if (verifiedCode && ac.squawk && ac.lastClearance?.type !== 'clearance') {
      transmit('controller', position, ac, `${ac.callsign}, verify transponder code ${ac.squawk}.`)
      transmit('pilot', position, ac, `Squawk ${ac.squawk}, ${ac.callsign}.`)
      return
    }
    const prior = ac.lastClearance
    if (!prior) return
    const ex = phraseFor(prior, phraseContext(ac))
    if (!ex) return
    transmit('controller', position, ac, negative(ex.instruction))
    transmit('pilot', position, ac, ex.readback)
  }

  /** The pilot's first call on a new frequency, right after a handoff. */
  function checkIn(ac: Internal): void {
    const rwy = runwayIdentFor(ac)
    if (ac.controlledBy === 'tower') {
      const where = rwy ? `holding short runway ${rwy}` : 'holding short'
      transmit('pilot', 'tower', ac, `Tower, ${ac.callsign}, ${where}.`)
    } else {
      const exit = ac.exit?.ref ?? ac.assignedExitRef
      transmit('pilot', 'ground', ac, `Ground, ${ac.callsign}, clear of the runway${exit ? ` at ${exit}` : ''}.`)
    }
  }

  const plan = (route: readonly Point[]): { path: Point[]; held: Point[] | null } => {
    if (!guard || route.length < 2) return { path: [...route], held: null }
    const { drive, held } = splitRouteAtRunway(route, guard)
    return { path: drive, held }
  }

  function makeInternal(init: AircraftInit): Internal {
    // An aircraft on final is above the surface, so the runway hold-short split must not
    // apply — its path deliberately ends *on* the runway, at the landing threshold.
    const airborne = init.airborne === true
    // An arrival that lands with nowhere to go stops on the runway after the handoff: never
    // counted, never removed, blocking the runway for good. Reject it at the boundary instead.
    if (airborne && !init.goalPoint)
      throw new Error(`airborne arrival "${init.id}" needs a goalPoint (the gate it taxis to)`)
    const { path, held } = airborne ? { path: [...init.path], held: null } : plan(init.path)
    const start = path[0] ?? ([0, 0] as Point)
    const next = path[1]
    const heading = init.heading ?? (next ? bearing(start[0], start[1], next[0], next[1]) : 0)
    const threshold = airborne ? (path[path.length - 1] ?? null) : null
    const finalLenNm = threshold ? pathLength(path) : 0
    // The descent is the *arrival's own* runway's published glide path, not one hard-coded angle
    // and not the primary runway's: KSAN is 3.3° to 09 and 3.5° to 27, and with two runways active
    // a 15 arrival (3.25°) and an 08 arrival (3.0°) are on final at once (docs/atc-multi-runway.md).
    const finalAltFt = glideAltitudeFt(
      (runwayAtThreshold(threshold) ?? runway)?.glidePathDeg ?? DEFAULT_GLIDE_DEG,
      finalLenNm,
    )
    return {
      id: init.id,
      callsign: init.callsign,
      type: init.type,
      wake: init.wake,
      x: start[0],
      y: start[1],
      heading: normalizeDeg(heading),
      altitude: airborne ? finalAltFt : 0,
      groundspeed: airborne ? init.targetSpeed : 0,
      holding: !airborne && path.length < 2,
      holdShort: !airborne && path.length < 2 && held !== null,
      // Arrivals on final are Local Control's from the moment they appear; they are handed
      // to Ground only once they have rolled out and can leave the runway.
      controlledBy: airborne ? 'tower' : 'ground',
      intent: init.intent ?? 'departure',
      gate: init.gate ?? null,
      conflict: false,
      converging: false,
      runwayAuth: null,
      incursion: false,
      hotspot: null,
      path,
      leg: 0,
      targetSpeed: init.targetSpeed,
      goalPoint: init.goalPoint ?? null,
      dwell: -1,
      held,
      pushingBack: false,
      giveWayTo: null,
      squawk: null,
      departing: false,
      lineUpWait: false,
      lineUpBehind: null,
      airborne,
      clearedToLand: false,
      rollingOut: false,
      threshold,
      finalLenNm,
      finalAltFt,
      exit: null,
      assignedExitRef: null,
      brakeRate: ROLLOUT_DECEL,
      speedLimits: [],
      vacated: false,
      groundPending: false,
      fleet: init.fleet ?? null,
      services: (init.intent ?? 'departure') === 'departure' ? servicesFor(init.fleet ?? null) : [],
      blockedEdge: null,
      blockedBy: null,
      heldSec: 0,
      awaitingSec: 0,
      avoidEdges: new Set(),
      divertTried: new Set(),
      pushFacing: null,
      pushFacingLabel: null,
      facingCommitted: null,
      rollWhenLinedUp: false,
      lastClearance: null,
      issuedSquawk: null,
      edctSec: null,
    }
  }

  // The two runway thresholds (farthest-apart centerline endpoints), for takeoff rolls.
  const runwayEnds: Point[] = (() => {
    if (!guard) return []
    const pts = guard.segments.flatMap((s) => [s.a, s.b])
    let a: Point | null = null
    let b: Point | null = null
    let far = -1
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const d = dist(pts[i]!, pts[j]!)
        if (d > far) {
          far = d
          a = pts[i]!
          b = pts[j]!
        }
      }
    }
    return a && b ? [a, b] : []
  })()
  const farRunwayEnd = (from: Point): Point | null => {
    // Resolve by the runway `from` sits on: its active direction gives the far end a takeoff rolls
    // toward and a landing rolls out to. On a single-runway field everyone is on the one runway, so
    // this is the old `runway.farEnd`; on a crossing field a point on runway B gets B's far end.
    const id = guard ? runwayIdAt(from, guard) : null
    const dir = id !== null ? active.find((a) => a.id === id)?.dir : undefined
    if (dir) return dir.farEnd
    if (runway) return runway.farEnd // off the pavement (id null): the primary active direction
    if (runwayEnds.length < 2) return null
    return dist(from, runwayEnds[0]!) >= dist(from, runwayEnds[1]!) ? runwayEnds[0]! : runwayEnds[1]!
  }
  /** The point on the runway centerline nearest an aircraft — where it lines up when told to
   *  line up and wait (i.e. onto the runway in front of it, not at some far threshold).
   *  NOTE: single-runway assumption. KSAN has one runway (9/27), so "nearest segment" is always
   *  the right runway. With crossing/second runways, scope this to the aircraft's assigned
   *  runway (the one its goalPoint sits on) — see docs/atc-tower.md §9 (multiple runways). */
  const nearestRunwayPoint = (from: Point): Point | null => {
    if (!guard) return null
    let best: Point | null = null
    let bestD = Infinity
    for (const s of guard.segments) {
      const vx = s.b[0] - s.a[0]
      const vy = s.b[1] - s.a[1]
      const l2 = vx * vx + vy * vy
      let t = l2 > 0 ? ((from[0] - s.a[0]) * vx + (from[1] - s.a[1]) * vy) / l2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const p: Point = [s.a[0] + t * vx, s.a[1] + t * vy]
      const d = dist(from, p)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  }

  // Runway turnoffs, derived per landing direction and cached (graph.topology() is not cheap).
  const exitCache = new Map<string, RunwayExit[]>()
  function exitsForLanding(threshold: Point): RunwayExit[] {
    const key = `${threshold[0]},${threshold[1]}`
    const hit = exitCache.get(key)
    if (hit) return hit
    // Turnoffs are bounded by the *declared* landing distance, not by the pavement: on KSAN 09
    // the last ~1,100 ft is physically there but is not landing distance available. The active
    // direction on the threshold's runway supplies the declared LDA; anything else falls back to
    // the pavement far end.
    const landingDir =
      guard ? active.find((a) => a.id === runwayIdAt(threshold, guard))?.dir : undefined
    const far =
      landingDir && dist(threshold, landingDir.threshold) < 1e-6
        ? landingEnd(landingDir)
        : farRunwayEnd(threshold)
    const exits = graph && guard && far ? buildRunwayExits(graph.topology(), guard, threshold, far) : []
    exitCache.set(key, exits)
    return exits
  }
  /** How far (nm) a point lies down the runway from a landing threshold. */
  function alongRunway(threshold: Point, p: Point): number {
    const far = farRunwayEnd(threshold)
    if (!far) return 0
    const dx = far[0] - threshold[0]
    const dy = far[1] - threshold[1]
    const len = Math.hypot(dx, dy) || 1
    return ((p[0] - threshold[0]) * dx + (p[1] - threshold[1]) * dy) / len
  }
  /** The turnoffs this arrival could still be assigned: ahead of it, and slow-downable for. */
  /**
   * Whether another aircraft is standing in this turnoff, or is already committed to taking it.
   *
   * A turnoff is a one-aircraft place. An arrival that has vacated and checked in with Ground
   * sits at the far end of the connector until it is taxied, so a second landing sent to the
   * same one would brake for a turn and find the pavement taken — and a rollout is the one
   * movement separation cannot rescue, because it meets the aircraft ahead inside the curve at
   * a speed it cannot stop from.
   */
  function exitBlocked(ac: Internal, e: RunwayExit): boolean {
    return fleet.some((o) => {
      if (o === ac || o.airborne) return false
      const here: Point = [o.x, o.y]
      for (let i = 1; i < e.geom.length; i += 1) {
        if (distToSegment(here, e.geom[i - 1] as Point, e.geom[i] as Point) < EXIT_BLOCKED_NM) return true
      }
      return false
    })
  }

  function exitOptionsFor(ac: Internal): RunwayExit[] {
    if (ac.intent !== 'arrival' || !ac.threshold || ac.vacated) return []
    const at = ac.airborne ? 0 : alongRunway(ac.threshold, [ac.x, ac.y])
    const speed = ac.airborne ? ac.targetSpeed : ac.groundspeed
    return exitsForLanding(ac.threshold).filter((e) => {
      const remaining = e.distanceNm - at
      if (remaining <= 0 || brakeRateFor(speed, e.speedKt, remaining) > MAX_BRAKE_KT_S) return false
      return !exitBlocked(ac, e)
    })
  }

  const fleet: Internal[] = inits.map(makeInternal)
  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  function statusOf(ac: Internal): GroundStatus {
    if (ac.airborne) return ac.clearedToLand ? 'landing' : 'onFinal'
    if (ac.rollingOut) return 'rollout'
    if (ac.departing || ac.rollWhenLinedUp) return 'departing'
    if (ac.pushingBack) return 'pushback'
    if (ac.lineUpWait) return 'lineUpWait'
    if (ac.holdShort) return 'holdShort'
    if (ac.dwell >= 0) return 'parked'
    // `holding` is the authoritative "stopped" flag (set each tick in advance()). Trust
    // it rather than re-deriving taxi-vs-hold from the nominal targetSpeed, which stays
    // > 0 even when a separation / reservation / give-way cap has forced a full stop —
    // that divergence used to report a mid-route traffic hold as 'taxi'.
    if (!ac.holding) return 'taxi'
    if (ac.path.length < 2 && ac.held === null) return 'parked'
    return 'holding'
  }

  /**
   * Whether this aircraft is waiting on the *controller* — stopped, under Ground, with no
   * clearance left to run and nothing else to be waiting for. See
   * {@link GroundAircraft.awaitingSec} for what this is and what it deliberately excludes.
   */
  function awaitingInstruction(ac: Internal): boolean {
    // Whichever position owns it. An arrival that has vacated and stopped, still on Tower's
    // frequency because the handoff was never issued, is the same aircraft with the same
    // problem as one that has checked in with Ground and been told nothing since — it is
    // simply forgotten one step earlier. `rollingOut` is not excluded for that reason: a
    // rollout that has come to a stop has finished rolling out in every sense but the flag.
    if (!ac.holding) return false
    // Lined up on the runway waiting for a takeoff clearance is also waiting on the controller,
    // and is deliberately not counted — see the exclusions in `GroundAircraft.awaitingSec`.
    if (ac.airborne || ac.departing || ac.pushingBack || ac.lineUpWait) return false
    // On a stand — arrived and dwelling, or a departure waiting for its clearance. Both are
    // already said elsewhere, and neither is holding anything up.
    if (ac.dwell >= 0 || atGate(ac) || ac.path.length < 2) return false
    // Holding short of a runway, or giving way: it has a clearance and is waiting on something
    // real. The clock is for an aircraft nobody has said anything to.
    if (ac.holdShort || ac.held !== null || ac.giveWayTo !== null) return false
    return ac.leg >= ac.path.length - 1
  }

  /** Accrue each aircraft's wait on the controller, and reset it the moment it has something to
   *  do. Runs after the movement resolves, so a clearance issued this tick shows as zero. */
  function tickAwaiting(dt: number): void {
    for (const ac of fleet) {
      ac.awaitingSec = awaitingInstruction(ac) ? ac.awaitingSec + dt : 0
    }
  }

  /** True while a departure is still parked at its gate (not pushed back or rolling). */
  function atGate(ac: Internal): boolean {
    return ac.intent === 'departure' && !ac.pushingBack && !ac.departing && ac.path.length < 2
  }

  /** Seconds until the longest remaining ground service completes (0 = ready / none). */
  function serviceRemaining(ac: Internal): number {
    let m = 0
    for (const s of ac.services) if (s.remaining > m) m = s.remaining
    return m
  }

  /** Drain each parked departure's parallel services by dt. */
  function tickServices(dt: number): void {
    for (const ac of fleet) {
      if (ac.services.length === 0 || !atGate(ac)) continue
      for (const s of ac.services) s.remaining = Math.max(0, s.remaining - dt)
    }
  }

  /** True when this aircraft is holding short of its *own departure runway* (a takeoff hold,
   *  eligible for a tower handoff) rather than holding short to *cross* the runway. Mirrors the
   *  contactTower guard, so the UI can offer Contact-tower vs Cross-runway correctly. */
  function holdingForTakeoff(ac: Internal): boolean {
    if (!ac.holdShort || ac.intent !== 'departure') return false
    if (!guard) return true // no runway model → no crossing distinction
    return ac.goalPoint !== null && onRunway(ac.goalPoint, guard)
  }

  /** Whether an aircraft is physically on the runway surface right now. An aircraft on final
   *  is over it, not on it, so it isn't a surface occupant until touchdown. */
  function onRunwayNow(ac: Internal): boolean {
    return !ac.airborne && guard ? onRunway([ac.x, ac.y], guard) : false
  }
  /** Whether an aircraft occupies the runway in a way that blocks another aircraft's takeoff
   *  clearance: any on-runway aircraft, except a departure that has rotated (near liftoff and
   *  effectively airborne) — the next departure may be cleared behind it. */
  function occupiesForTakeoff(ac: Internal): boolean {
    // A landing aircraft owns the runway until it is past its turnoff's hold-short point —
    // "clear of the runway" is not the moment its centre leaves the pavement band.
    if (ac.rollingOut && !ac.vacated) return true
    return onRunwayNow(ac) && !(ac.departing && ac.groundspeed >= ROTATE_KT)
  }

  /** Distance (nm) an arrival still has to fly to its landing threshold; 0 when not on final. */
  function finalDistance(ac: Internal): number {
    return ac.airborne && ac.threshold ? dist([ac.x, ac.y], ac.threshold) : 0
  }

  /** An arrival inside short final owns the runway: it is committed enough that nothing may
   *  be cleared onto the surface underneath it (7110.65 "anticipated separation" has limits). */
  function onShortFinal(ac: Internal): boolean {
    return ac.airborne && ac.intent === 'arrival' && finalDistance(ac) <= SHORT_FINAL_NM
  }

  /** The runway-clear predicate every Tower clearance consults: the runway is unavailable
   *  while anyone occupies its surface or is committed on short final above it.
   *  Field-wide (any runway); {@link blocksRunwayFor} is the per-runway form the gates use. */
  function blocksRunway(ac: Internal): boolean {
    return occupiesForTakeoff(ac) || onShortFinal(ac)
  }

  /** The physical runway an aircraft is standing on right now, or null if off all pavement (or
   *  airborne). "Which runway", where {@link onRunwayNow} answers "any runway". */
  function physicalRunwayOf(ac: Internal): string | null {
    return !ac.airborne && guard ? runwayIdAt([ac.x, ac.y], guard) : null
  }

  /** The runway an arrival is approaching — the one its landing threshold sits on. */
  function approachRunwayOf(ac: Internal): string | null {
    return guard && ac.threshold ? runwayIdAt(ac.threshold, guard) : null
  }

  /**
   * The runway an aircraft is asking to use — the authority for "which runway does this clearance
   * protect" (docs/atc-multi-runway.md §2). Derived in one place: an arrival by its threshold, a
   * departure by its goal (its departure end sits on the runway), else where it physically is,
   * else null. A single-runway field always resolves to its one runway, so the scoped gates below
   * reduce exactly to the field-wide ones.
   */
  function targetRunwayId(ac: Internal): string | null {
    if (!guard) return null
    if (ac.intent === 'arrival' && ac.threshold) return runwayIdAt(ac.threshold, guard)
    if (ac.goalPoint) {
      const byGoal = runwayIdAt(ac.goalPoint, guard)
      if (byGoal !== null) return byGoal
    }
    return physicalRunwayOf(ac)
  }

  /**
   * Whether `o` blocks a clearance on runway `runwayId`: the per-runway form of {@link blocksRunway}.
   * An occupant or a short-final arrival threatens its *own* runway, and any runway the field has
   * coupled to it for `kind` (docs/atc-multi-runway.md §6) — by default none, so traffic on an
   * unrelated runway is invisible here. With `runwayId` null (a runway that can't be resolved) it
   * falls back to the field-wide predicate, which is also exactly the single-runway behaviour.
   */
  /** The declared crossing point of two runways, or null if they do not cross (or none is stated). */
  function crossingBetween(a: string, b: string): Point | null {
    for (const c of runwayCrossings) {
      if ((c.runways[0] === a && c.runways[1] === b) || (c.runways[1] === a && c.runways[0] === b)) return c.point
    }
    return null
  }

  /**
   * Whether occupant `o` on runway `oId` still holds the runway it *crosses* (`protectedId`) — the
   * position-aware refinement of the occupancy coupling (docs/atc-multi-runway.md §6). The coupling
   * says a crossing pair holds each other; this says *for how long*: only until the moving aircraft
   * is past the intersection.
   *
   * Deliberately narrow. It relaxes the coupling for exactly one case — an aircraft **rolling**
   * (a departure, or a landing rollout) that has physically passed the crossing — because that is
   * the one that visibly clears the intersection and frees the other runway ("cleared for takeoff,
   * traffic has crossed"). Everything else stays conservative and holds: same runway, a coupling
   * with no stated crossing point, a stationary occupant (lined up, holding, stopped on the
   * pavement), and any traffic still short of the crossing. Never relaxes a same-runway hold.
   */
  function stillAtCrossing(o: Internal, oId: string | null, protectedId: string, kind: RunwayInteractionKind): boolean {
    if (kind !== 'occupancy' || oId === null || oId === protectedId) return true
    if (!(o.departing || o.rollingOut)) return true // only a moving roll earns the refinement
    const x = crossingBetween(oId, protectedId)
    if (!x) return true // no stated crossing → coarse coupling
    const dir = active.find((a) => a.id === oId)?.dir
    if (!dir) return true
    const ux = dir.farEnd[0] - dir.departureStart[0]
    const uy = dir.farEnd[1] - dir.departureStart[1]
    const len = Math.hypot(ux, uy)
    if (len < 1e-9) return true
    // Signed distance from o to the crossing along its runway's roll direction: positive while the
    // crossing is still ahead. Once it is CROSSING_CLEARED_NM behind, o has cleared the intersection.
    const ahead = ((x[0] - o.x) * ux + (x[1] - o.y) * uy) / len
    return ahead >= -CROSSING_CLEARED_NM
  }

  function blocksRunwayFor(o: Internal, runwayId: string | null, kind: RunwayInteractionKind): boolean {
    if (runwayId === null) return blocksRunway(o)
    // An arrival on short final is airborne — not yet a *moving* ground occupant — so the crossing
    // refinement below never relaxes it; it holds the coupled runway until it has landed and rolls.
    if (onShortFinal(o)) return runwaysRelated(approachRunwayOf(o), runwayId, kind)
    if (o.rollingOut && !o.vacated)
      return runwaysRelated(approachRunwayOf(o), runwayId, kind) && stillAtCrossing(o, approachRunwayOf(o), runwayId, kind)
    const oId = physicalRunwayOf(o)
    if (oId === null) return false
    if (oId === runwayId) return occupiesForTakeoff(o) // same runway: unchanged, rotation-based release
    if (!runwaysRelated(oId, runwayId, kind)) return false // an unrelated runway is invisible
    // A coupled *crossing* runway (a stated crossing point): the occupant holds `runwayId` while it
    // is physically on its own runway and short of the intersection — position, not rotation speed,
    // is what clears it, because a departure at 130 kt short of the crossing is still in the way and
    // `occupiesForTakeoff` would have released it at ROTATE. Without a crossing point (a coarse
    // coupling, e.g. dependent parallels) the established rotation-based occupancy stands.
    if (kind === 'occupancy' && crossingBetween(oId, runwayId))
      return onRunwayNow(o) && stillAtCrossing(o, oId, runwayId, kind)
    return occupiesForTakeoff(o)
  }

  /** Every runway a holding-short aircraft's held (crossing) route runs across — each one a
   *  crossing clearance must find clear. A held route is the whole remainder to the gate, so it
   *  can cross more than one runway; checking only the first would drive the aircraft across an
   *  occupied second runway. A single-runway field yields its one runway (or none, when the route
   *  never touches pavement — then the target runway stands in). */
  function crossedRunwayIds(ac: Internal): string[] {
    if (!guard || !ac.held) {
      const target = targetRunwayId(ac)
      return target === null ? [] : [target]
    }
    const ids = new Set<string>()
    for (const p of ac.held) {
      const id = runwayIdAt(p, guard)
      if (id !== null) ids.add(id)
    }
    if (ids.size === 0) {
      const target = targetRunwayId(ac)
      if (target !== null) ids.add(target)
    }
    return [...ids]
  }

  /**
   * Whether the runway is available for `ac` to line up on *right now*.
   *
   * Traffic that is moving away down the runway does not block a line-up behind it — that is
   * precisely what "line up and wait" is for. A departure rolling, and equally a landing rolling
   * out, are both leaving: docs/atc-operations.md §6 gives the rollout as the reason the
   * instruction exists ("the runway is not quite clear — a landing aircraft is still rolling
   * out"). Anything *stationary* on the pavement still blocks, including a rollout that has
   * stopped on it, because that one is not leaving at all.
   *
   * "On its way into position" counts as in position: an aircraft cleared to line up is
   * committed to the runway from the clearance, not from the moment its wheels reach the
   * centerline. Without that, two aircraft dispatched in the same tick were both accepted —
   * neither was physically on the runway yet, and both were told to taxi onto it.
   *
   * One predicate, two callers: the clearance asks it, and a conditional line-up asks it again
   * at the moment its condition comes true. They must not be able to disagree about the same
   * runway — the whole hazard of a conditional clearance is the gap between issuing and acting.
   *
   * (Line-up uses this "moving away" bar; the takeoff clearance keeps the stricter "rotated"
   * one — see clearedForTakeoff. That difference is the whole value of lining up early rather
   * than merely earlier.)
   */
  function canLineUpNow(ac: Internal): boolean {
    if (!guard) return true
    // Scope every bar to the runway `ac` is lining up on. A single-runway field resolves R to its
    // one runway, so each `R === null ||` short-circuit is never taken and this is the old check.
    const R = targetRunwayId(ac)
    const onThisRunway = (o: Internal): boolean =>
      R === null || runwaysRelated(physicalRunwayOf(o), R, 'occupancy')
    const forThisRunway = (o: Internal): boolean =>
      R === null || runwaysRelated(targetRunwayId(o), R, 'occupancy')
    const shortFinalHere = (o: Internal): boolean =>
      onShortFinal(o) && (R === null || runwaysRelated(approachRunwayOf(o), R, 'occupancy'))
    const leavingTheRunway = (o: Internal): boolean =>
      (o.departing || o.rollingOut) && o.groundspeed > ROLLING_KT
    return !fleet.some(
      (o) =>
        o !== ac &&
        (shortFinalHere(o) ||
          ((o.lineUpWait || o.rollWhenLinedUp) && forThisRunway(o)) ||
          (onRunwayNow(o) && !leavingTheRunway(o) && onThisRunway(o))),
    )
  }

  /**
   * Whether "expedite" has anything to act on. It is a *taxi* instruction: it raises the speed
   * the aircraft drives its remaining route at, so it needs a route left to drive and a phase
   * where target speed is what governs.
   *
   * A landing rollout is excluded because there the target speed is a ceiling, not a floor —
   * the aircraft is braking from approach speed under a solved deceleration profile, and
   * "expediting" it would *cap* it at taxi speed and slow it down. The lever for a rollout
   * that is slow to clear is the earlier turnoff (`assignExit`), which already exists. A
   * pushback is excluded for the same reason in the other direction: hurrying a tug is not a
   * thing, and the speed there is the push profile's.
   */
  function canExpedite(ac: Internal): boolean {
    if (ac.airborne || ac.rollingOut || ac.departing || ac.pushingBack || ac.lineUpWait) return false
    return ac.leg < ac.path.length - 1
  }

  /**
   * Whether this aircraft is holding short in order to **cross** — its route continues to the
   * far side — rather than to depart from the runway it is holding at.
   *
   * The discriminator is where the held portion *ends*. A transit's ends off the pavement; a
   * departure cleared to the runway (or to an intersection on it) ends on it, and "crossing"
   * such an aircraft would drive it onto the runway and park it there unaligned with no takeoff
   * clearance — a runway incursion issued by the controller.
   */
  function heldRouteCrosses(ac: Internal): boolean {
    if (!ac.held || ac.held.length < 2) return false
    // No runway model → no runways, so nothing is a crossing. (`plan` never splits a route
    // without a guard either, so this branch is belt and braces.)
    if (!guard) return false
    const end = ac.held[ac.held.length - 1]
    return end !== undefined && !onRunway(end, guard)
  }

  /**
   * This surface aircraft is on a crossing: holding short with a far side to reach, part-way
   * across, or across and waiting to be handed back.
   *
   * The last of those is why `controlledBy` is in here. Once an aircraft is off the pavement its
   * held route is spent and its crossing authority has been dropped, so nothing about its own
   * state still says "crossing" — but Local Control does not hold a *taxiing* aircraft for any
   * other reason, so Tower still owning it is the surviving evidence. Excludes everything
   * committed to the runway itself, which Tower holds for a quite different reason.
   */
  function onCrossing(ac: Internal): boolean {
    if (ac.airborne || ac.rollingOut || ac.lineUpWait || ac.departing || ac.rollWhenLinedUp) return false
    if (holdingForTakeoff(ac)) return false
    return ac.controlledBy === 'tower' || heldRouteCrosses(ac) || ac.runwayAuth !== null
  }

  /**
   * Whether "hold short of runway N" has anything to act on: a runway ahead on the route, and an
   * aircraft not already on it. True while taxiing toward the line (where it confirms what the
   * route already does), at the line (where it is the answer to a crossing request), and after a
   * crossing clearance that has not yet been acted on (where it takes that clearance back).
   */
  function canHoldShortNow(ac: Internal): boolean {
    if (ac.airborne || ac.rollingOut || ac.lineUpWait || ac.departing) return false
    if (onRunwayNow(ac)) return false
    // Either the route still stops at a runway, or it did until a crossing clearance released
    // it — and that clearance has not been used yet, since it is not on the pavement.
    return ac.held !== null || ac.runwayAuth === 'issued'
  }

  /**
   * Why an aircraft is being held short, worded for the air — or null when nothing is in the
   * way and the instruction stands on its own.
   *
   * The same traffic the runway-clear predicate finds, said out loud. A hold with no stated
   * cause is half a transmission: it tells the pilot what to do and nothing about the situation
   * they are in, and the situation is what makes it make sense.
   */
  function holdReasonFor(ac: Internal): string | null {
    const occupant = fleet.find((o) => o !== ac && occupiesForTakeoff(o))
    if (occupant) return 'traffic on the runway'
    const inbound = fleet.find((o) => o !== ac && o.airborne && o.intent === 'arrival' && o.threshold)
    if (!inbound) return null
    // Whole miles, as it is said: "a 3 mile final", never "a 2.7 mile final".
    return `traffic on a ${Math.max(1, Math.round(finalDistance(inbound)))} mile final`
  }

  /** Put a released crossing route back on hold at the runway, undoing a crossing clearance the
   *  aircraft has not acted on. Returns false when there is no runway ahead to hold short of. */
  function reholdAtRunway(ac: Internal): boolean {
    const remaining: Point[] = [[ac.x, ac.y], ...ac.path.slice(ac.leg + 1)]
    const { path, held } = plan(remaining)
    if (!held) return false
    ac.path = path
    ac.leg = 0
    ac.held = held
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
    return true
  }

  /** What an aircraft on the runway is doing there, or null when it isn't on it. Ordered by
   *  authority: a takeoff clearance outranks a line-up, which outranks a crossing. Anything on
   *  the pavement that matches none of them holds no permission to be there. */
  function runwayUse(ac: Internal): RunwayUse | null {
    if (!onRunwayNow(ac)) return null
    if (ac.departing || ac.rollWhenLinedUp) return 'takeoff'
    if (ac.lineUpWait) return 'lineUp'
    if (ac.rollingOut) return 'rollout'
    if (ac.runwayAuth) return 'crossing'
    return 'unauthorized'
  }

  /** Advance the crossing permission's little latch (see {@link Internal.runwayAuth}) and
   *  recompute who is in conflict on the runway. */
  function detectRunwayIncursions(): RunwayIncursion[] {
    for (const ac of fleet) {
      if (ac.runwayAuth === 'issued' && onRunwayNow(ac)) ac.runwayAuth = 'on'
      else if (ac.runwayAuth === 'on' && !onRunwayNow(ac)) ac.runwayAuth = null
    }
    const found = detectIncursions(
      fleet.map((ac) => ({
        id: ac.id,
        callsign: ac.callsign,
        use: runwayUse(ac),
        // Under power and going: the same bar the line-up clearance itself uses, so the
        // instruction and the alert cannot disagree about whether an aircraft is leaving.
        movingAway: (ac.departing || ac.rollingOut) && ac.groundspeed > ROLLING_KT,
        airborne: ac.airborne,
        clearedToLand: ac.clearedToLand,
        finalNm: finalDistance(ac),
      })),
    )
    const flagged = new Set(found.flatMap((i) => [i.occupantId, ...(i.conflictId ? [i.conflictId] : [])]))
    for (const ac of fleet) ac.incursion = flagged.has(ac.id)
    return found
  }

  /**
   * The path an aircraft drives to line up: along the connector it is holding on, onto the
   * runway, then a short roll so it ends pointing down it.
   *
   * The geometry has to come from the *graph*, not from the aircraft's held clearance. A taxi
   * clearance to a point on the runway routes to the hold-short node and then appends the exact
   * goal, so the held portion is a straight chord from the hold line to somewhere on the
   * pavement — none of the connector's curve survives in it. Driving that (or driving straight
   * at the nearest centerline point) makes the aircraft cut across the fillet and kink onto the
   * runway instead of turning through it.
   */
  /**
   * A generated line-up curve: a smooth arc from where the aircraft is holding onto the runway
   * centerline, tangent to how it is pointing at the start and to the takeoff direction at the end,
   * so it turns *through* the fillet instead of cutting straight across it and kinking. Unlike a
   * graph search it cannot loop across the runway (it is constructed, not searched), and unlike the
   * charted route it does not depend on the field's taxi data having a node planted on the stripe —
   * which most connectors do not, so a straight cut was the fallback everywhere they lack one.
   *
   * A cubic Bézier does the work: the aircraft's heading sets the start tangent, the runway
   * direction the end tangent, and the endpoint sits on the centerline a lead ahead of the
   * perpendicular foot, toward the far end — so the curve arrives aligned and rolling, not crabbed.
   */
  function filletLineUp(ac: Internal): Point[] {
    const p0: Point = [ac.x, ac.y]
    const base = nearestRunwayPoint(p0)
    const far = base ? farRunwayEnd(base) : null
    if (!base || !far) return [p0] // no runway to line up on — nothing sensible to build
    const rlen = dist(base, far) || 1
    const rx = (far[0] - base[0]) / rlen
    const ry = (far[1] - base[1]) / rlen // unit vector down the takeoff direction
    // Aim a lead ahead of the perpendicular foot so the arc has room to turn; the further the
    // aircraft is holding off the stripe, the more room it needs, so the lead tracks that offset —
    // clamped so it always has room and never carries the aircraft far down the runway to line up.
    const lead = Math.min(
      Math.max(dist(p0, base), LINEUP_FILLET_MIN_LEAD_NM),
      LINEUP_FILLET_MAX_LEAD_NM,
    )
    const entry: Point = [base[0] + rx * lead, base[1] + ry * lead]
    // Start tangent: the direction the aircraft is pointing. If that faces away from the entry (a
    // hold-short that stopped turned round), aim straight at the entry instead of curving backwards.
    const hr = (ac.heading * Math.PI) / 180
    let sx = Math.sin(hr)
    let sy = Math.cos(hr)
    const tx = entry[0] - p0[0]
    const ty = entry[1] - p0[1]
    if (sx * tx + sy * ty <= 0) {
      const tl = Math.hypot(tx, ty) || 1
      sx = tx / tl
      sy = ty / tl
    }
    const chord = dist(p0, entry)
    const h = LINEUP_FILLET_TENSION * chord
    const c1: Point = [p0[0] + sx * h, p0[1] + sy * h]
    const c2: Point = [entry[0] - rx * h, entry[1] - ry * h]
    const pts: Point[] = []
    for (let i = 0; i <= LINEUP_FILLET_SAMPLES; i += 1) {
      const t = i / LINEUP_FILLET_SAMPLES
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const c = 3 * u * t * t
      const d = t * t * t
      pts.push([
        a * p0[0] + b * c1[0] + c * c2[0] + d * entry[0],
        a * p0[1] + b * c1[1] + c * c2[1] + d * entry[1],
      ])
    }
    // One short step straight down the runway so the final segment is *exactly* the takeoff
    // direction — the sampled Bézier only approaches it — leaving the aircraft aligned rather than
    // a few degrees crabbed when it stops. Short, so it barely adds to the line-up distance.
    pts.push([entry[0] + rx * LINEUP_FILLET_ALIGN_NM, entry[1] + ry * LINEUP_FILLET_ALIGN_NM])
    return pts
  }

  /**
   * The path a departure follows from holding short onto the runway centerline, aligned for
   * takeoff — a generated fillet ({@link filletLineUp}). It replaced three data-dependent attempts
   * (a graph search to a charted centerline node, the aircraft's held route, and a straight cut)
   * that each worked at some hold-short points and kinked or looped at others: the search could
   * route across the runway to a node on the far side, the held route was often a straight chord,
   * and the field data plants a node on the stripe at almost no connector. The fillet needs none of
   * that — it turns from the aircraft's heading onto the runway direction wherever it is holding.
   */
  function lineUpPath(ac: Internal): Point[] {
    return filletLineUp(ac)
  }

  /**
   * Runway (nm) left ahead of an aircraft in the takeoff direction. Negative when it is past the
   * far end — i.e. lined up facing the wrong way for the runway in use.
   */
  function takeoffRunRemaining(ac: Internal): number {
    const r = activeRunwayFor(ac)
    const far = r ? takeoffEnd(r) : farRunwayEnd([ac.x, ac.y])
    if (!far) return Infinity
    // Without a configuration `farRunwayEnd` answers "whichever end is further away", so this
    // measures toward that end by construction and effectively never trips — the legacy path
    // never had the wrong-end bug this guards against.
    const from = r?.departureStart ?? null
    if (!from) return dist([ac.x, ac.y], far)
    const dx = far[0] - from[0]
    const dy = far[1] - from[1]
    const len = Math.hypot(dx, dy) || 1
    return ((far[0] - ac.x) * dx + (far[1] - ac.y) * dy) / len
  }

  /**
   * Why an aircraft can't roll from where it is, or null if it can. Distinguishes the two very
   * different reasons: it is at the *other* end of the field, so the runway it is pointing down
   * simply isn't the one in use — or it is on the right runway but too far along it.
   */
  function takeoffBlocked(ac: Internal): string | null {
    const remaining = takeoffRunRemaining(ac)
    if (remaining >= MIN_TAKEOFF_RUN_NM) return null
    const r = activeRunwayFor(ac)
    if (r) {
      const here: Point = [ac.x, ac.y]
      const atFarEnd = dist(here, r.farEnd) < dist(here, r.departureStart)
      if (atFarEnd)
        return `RWY ${reciprocalIdent(r.ident)} is not in use — RWY ${r.ident} is the active runway`
    }
    return 'insufficient runway remaining for takeoff'
  }

  /** The departure whose wake `ac` must wait behind: the most recent on its own runway, and on any
   *  runway the field couples to it for wake (close parallels — docs/atc-multi-runway.md §6),
   *  whichever binds `ac` longest. With no coupling this is just `ac`'s own runway's leader. */
  function wakeLeaderFor(ac: Internal): { wake: WakeCategory; atTime: number } | undefined {
    const mine = targetRunwayId(ac) ?? ''
    let leader: { wake: WakeCategory; atTime: number } | undefined
    let longest = -Infinity
    for (const [rid, dep] of lastDepartureByRunway) {
      if (!runwaysRelated(mine, rid, 'wake')) continue
      const remaining = wakeSeparationSec(dep.wake, ac.wake) * WAKE_TIME_SCALE - (time - dep.atTime)
      if (remaining > longest) {
        longest = remaining
        leader = dep
      }
    }
    return leader
  }

  /** Seconds of wake separation still owed before this holding-short departure may roll. */
  function wakeHoldFor(ac: Internal): number {
    if (ac.intent !== 'departure' || !(ac.holdShort || ac.lineUpWait)) return 0
    const leader = wakeLeaderFor(ac)
    if (!leader) return 0
    const required = wakeSeparationSec(leader.wake, ac.wake) * WAKE_TIME_SCALE
    return Math.max(0, Math.ceil(required - (time - leader.atTime)))
  }

  /** Speed cap (kt) for one aircraft from traffic ahead in its corridor. */
  function separationCap(ac: Internal): number {
    if (ac.targetSpeed <= 0 && ac.groundspeed <= 0) return Infinity
    const rad = (ac.heading * Math.PI) / 180
    const hx = Math.sin(rad)
    const hy = Math.cos(rad)
    let cap = Infinity
    for (const o of fleet) {
      if (o === ac || o.airborne) continue // traffic on final is not a surface obstacle
      // Aircraft parked at a gate (single-point, stationary) or dwelling aren't
      // movement-area obstacles — otherwise neighbours block each other at the gates.
      if (o.dwell >= 0 || (o.path.length < 2 && o.groundspeed <= 0.1)) continue
      const dx = o.x - ac.x
      const dy = o.y - ac.y
      const forward = dx * hx + dy * hy // projection onto heading
      if (forward <= 0 || forward > LOOK_AHEAD_NM) continue
      const cross = hx * dy - hy * dx // >0 = left, <0 = right
      if (Math.abs(cross) > CORRIDOR_HALF_NM) continue
      // Same-direction traffic ahead is a leader — queue behind it (gap cap below).
      // Crossing/opposing traffic is a right-of-way contest: slow only for whoever
      // outranks us. Since outranks() is a *total* order, exactly one of any pair
      // yields, so two aircraft can never both stop for each other — no deadlock,
      // and a head-on resolves to one holding while the other proceeds.
      const sameDir = angleDelta(ac.heading, o.heading) < SAME_DIR_DEG
      if (!sameDir && !outranks(o, ac)) continue // ac has right of way — hold speed
      const gap = forward - MIN_GAP_NM
      const c = gap <= 0 ? 0 : (gap / (LOOK_AHEAD_NM - MIN_GAP_NM)) * TAXI_SPEED_KT
      if (c < cap) cap = c
    }
    return cap
  }

  /** The graph node behind ac, the node ahead, the one after it, and the along-path
   * distance to the node ahead. Nulls where a route end/synthetic point intervenes. */
  interface EdgeCtx {
    prev: string | null
    next: string | null
    after: string | null
    distToNext: number
  }
  function edgeCtx(ac: Internal): EdgeCtx | null {
    if (!graph) return null
    const keyAtIdx = (i: number): string | null => {
      const p = ac.path[i]
      return p ? graph.keyAt(p) : null
    }
    let prev: string | null = null
    for (let i = Math.min(ac.leg, ac.path.length - 1); i >= 0; i -= 1) {
      const k = keyAtIdx(i)
      if (k) {
        prev = k
        break
      }
    }
    let next: string | null = null
    let nextIdx = -1
    for (let i = ac.leg + 1; i < ac.path.length; i += 1) {
      const k = keyAtIdx(i)
      if (k) {
        next = k
        nextIdx = i
        break
      }
    }
    if (!next) return { prev, next: null, after: null, distToNext: Infinity }
    let after: string | null = null
    for (let i = nextIdx + 1; i < ac.path.length; i += 1) {
      const k = keyAtIdx(i)
      if (k) {
        after = k
        break
      }
    }
    let d = 0
    let px = ac.x
    let py = ac.y
    for (let i = ac.leg + 1; i <= nextIdx; i += 1) {
      const q = ac.path[i]
      if (!q) continue
      d += Math.hypot(q[0] - px, q[1] - py)
      px = q[0]
      py = q[1]
    }
    return { prev, next, after, distToNext: d }
  }

  /**
   * Speed cap that reserves one-lane taxiway segments. An aircraft may not *enter*
   * its next edge while opposing traffic occupies it, or is about to enter it and
   * outranks us — instead it decelerates to a stop just short of that edge's mouth,
   * leaving the junction clear for the aircraft that has it. Because entry ties break
   * on the same total order as {@link outranks}, exactly one of any pair yields, so two
   * aircraft never both hold for the same segment. Graph-only (needs edge topology).
   */
  function reservationCap(ac: Internal): number {
    ac.blockedEdge = null
    ac.blockedBy = null
    const ctx = edgeCtx(ac)
    if (!ctx || !ctx.next || !ctx.after) return Infinity
    if (ctx.distToNext > RESERVE_HORIZON_NM) return Infinity
    const from = ctx.next // the node at the mouth of the edge we're about to enter
    const to = ctx.after
    let hold = false
    for (const o of fleet) {
      if (o === ac || o.dwell >= 0) continue
      const oc = edgeCtx(o)
      if (!oc) continue
      // o is physically on the contested edge, coming the other way:
      const occupies = oc.prev === to && oc.next === from
      // o is about to enter the contested edge against us:
      const contends = oc.next === to && oc.after === from
      if (occupies || (contends && outranks(o, ac))) {
        hold = true
        ac.blockedBy = o.id
        break
      }
    }
    if (!hold) return Infinity
    ac.blockedEdge = edgeKey(from, to)
    const d = ctx.distToNext - HOLD_MARGIN_NM
    return d <= 0 ? 0 : Math.min(TAXI_SPEED_KT, (d / HOLD_RAMP_NM) * TAXI_SPEED_KT)
  }

  /** Summed length (nm) of a node-point path. */
  function pathLength(pts: readonly Point[]): number {
    let sum = 0
    for (let i = 1; i < pts.length; i += 1) sum += dist(pts[i - 1]!, pts[i]!)
    return sum
  }

  /**
   * Parallel-taxiway diversion: an aircraft that has been reservation-held at a junction
   * for {@link DIVERT_AFTER_SEC} reroutes to its current destination *around* the contested
   * edge — but only if a path avoiding it exists and the detour stays within
   * {@link DIVERSION_COST_FACTOR} of the direct route (else waiting is cheaper). This dissolves
   * the pass-through degrade cases and lets an aircraft leave an occupancy cycle when a
   * parallel exists. Deterministic: fixed-timestep hold accrual, no randomness.
   */
  function maybeDivert(ac: Internal): void {
    if (!graph || ac.heldSec < DIVERT_AFTER_SEC) return
    const blocked = ac.blockedEdge
    if (!blocked || ac.divertTried.has(blocked)) return
    if (ac.held) return // holding short of a runway is a Tower matter, not a taxi jam
    if (ac.leg >= ac.path.length - 1) return
    const dest = ac.path[ac.path.length - 1]
    if (!dest) return
    // An aircraft routed onto a stand ends its path on the paint, off the graph. Divert to
    // where the lead-in *starts* and re-append the line, or the detour hands back exactly the
    // straight-across-the-apron arrival this geometry exists to prevent.
    const stand = standFor(ac)
    const onStand = stand !== undefined && dist(dest, stand.stop) < 1e-6
    const target: Point = onStand && stand ? stand.entry : dest
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = graph.nearestNode(target)
    if (!startKey || !goalKey) return
    const avoid = new Set(ac.avoidEdges)
    avoid.add(blocked)
    const alt = graph.routeAvoiding(startKey, goalKey, avoid, committedHeading(ac))
    if (alt.length === 0) {
      ac.divertTried.add(blocked)
      return
    }
    const direct = graph.route(startKey, goalKey, committedHeading(ac))
    if (direct.length > 0 && pathLength(alt) > DIVERSION_COST_FACTOR * pathLength(direct)) {
      ac.divertTried.add(blocked)
      return
    }
    ac.avoidEdges = avoid
    if (onStand && stand) {
      applyRoute(ac, [...alt, ...stand.lead], stand.stop, false)
    } else {
      // Preserve an exact appended goal (e.g. a point that isn't a graph node).
      const goalPt = graph.nodePoint(goalKey)
      applyRoute(ac, alt, dest, !goalPt || dist(goalPt, dest) > 1e-6)
    }
    ac.heldSec = 0
    ac.blockedEdge = null
  }

  /**
   * Manual give-way: hold for a specific aircraft the controller named, until it passes.
   * Holds (cap 0) while the target is within watch range and still ahead/beside; releases
   * automatically once the target has moved behind us or wandered far off (then it's cleared,
   * so the aircraft continues on its own). A no-op if the target is already behind us.
   */
  function giveWayCap(ac: Internal): number {
    if (!ac.giveWayTo) return Infinity
    const o = find(ac.giveWayTo)
    if (!o || o === ac) {
      ac.giveWayTo = null
      voidClearance(ac, 'giveWay')
      return Infinity
    }
    const dx = o.x - ac.x
    const dy = o.y - ac.y
    const rad = (ac.heading * Math.PI) / 180
    const forward = dx * Math.sin(rad) + dy * Math.cos(rad)
    const d = Math.hypot(dx, dy)
    if (forward < -GIVEWAY_CLEARED_NM || d > GIVEWAY_FORGET_NM) {
      ac.giveWayTo = null // traffic has passed behind us, or is well clear — done giving way
      voidClearance(ac, 'giveWay') // …and the instruction naming that traffic is spent
      return Infinity
    }
    return d <= GIVEWAY_WATCH_NM ? 0 : Infinity // hold only once it's actually near
  }

  /** The charted hot spot an aircraft is currently inside, or null. */
  function hotspotOf(ac: Internal): string | null {
    return hotspots.length === 0 || ac.airborne ? null : hotspotAt([ac.x, ac.y], hotspots)
  }

  /**
   * Taxi conflicts, now and developing.
   *
   * Proximity alone was a report rather than a warning — see `converging.ts`, which owns the
   * model. This sets the per-aircraft flags the scope draws rings from and keeps the pair list
   * for the alert line, the same way `detectRunwayIncursions` does for the runway.
   */
  function detectConflicts(): void {
    for (const ac of fleet) {
      ac.conflict = false
      ac.converging = false
      ac.hotspot = hotspotOf(ac)
    }
    // Neither a takeoff roll nor an aircraft on final is a surface conflict. A landing rollout
    // is: it is on the pavement, and what it can run into is the aircraft in its turnoff.
    const views: ConflictView[] = fleet
      .filter((ac) => !ac.departing && !ac.airborne)
      .map((ac) => ({
        id: ac.id,
        callsign: ac.callsign,
        at: [ac.x, ac.y] as Point,
        // The route it has left to run, from where it is. Everything behind it is history, and
        // a projection that started at the top of the clearance would predict the past.
        path: [[ac.x, ac.y] as Point, ...ac.path.slice(ac.leg + 1)],
        headingDeg: ac.heading,
        speedKt: ac.groundspeed,
        hotspot: ac.hotspot,
        // Who it is already being held for: the reservation's winner, the give-way target, or
        // both. That hold resolves those pairs; it says nothing about anyone else this
        // aircraft is closing on, which is why the ids travel rather than a flag.
        yieldingTo: [ac.blockedBy, ac.giveWayTo].filter((id): id is string => id !== null),
      }))

    conflicts = detectConverging(views)
    const byId = new Map(fleet.map((ac) => [ac.id, ac]))
    for (const c of conflicts) {
      for (const id of c.aircraftIds) {
        const ac = byId.get(id)
        if (!ac) continue
        if (c.severity === 'alert') ac.conflict = true
        else ac.converging = true
      }
    }
    // One aircraft, one state. With three or more it is perfectly possible to be nose-to-nose
    // with one and merely converging with another, and the scope draws a ring per aircraft —
    // so the worse of the two wins rather than both being painted at once.
    for (const ac of fleet) if (ac.conflict) ac.converging = false
  }

  function advance(ac: Internal, dt: number, cap: number): void {
    const atEnd = ac.leg >= ac.path.length - 1
    // A takeoff roll accelerates hard and does not slow at the end — it lifts off. An aircraft
    // on final likewise flies its approach speed to the threshold; touchdown is resolved after
    // the motion, not by braking in the air.
    const target = ac.departing || ac.airborne ? ac.targetSpeed : Math.min(atEnd ? 0 : ac.targetSpeed, cap)
    const accel = ac.departing ? TAKEOFF_ACCEL : ac.rollingOut ? ac.brakeRate : TAXI_ACCEL

    if (ac.groundspeed < target) {
      ac.groundspeed = Math.min(target, ac.groundspeed + accel * dt)
    } else if (ac.groundspeed > target) {
      ac.groundspeed = Math.max(target, ac.groundspeed - accel * dt)
    }

    const stopped = ac.groundspeed <= 0.01 && target === 0
    ac.holding = stopped
    ac.holdShort = stopped && atEnd && ac.held !== null
    if (stopped) {
      ac.groundspeed = 0
      if (ac.pushingBack && atEnd) {
        ac.pushingBack = false // finished pushing onto the taxilane
        if (ac.pushFacing !== null) {
          ac.heading = normalizeDeg(ac.pushFacing)
          // It is now committed: it cannot turn round on the alley, so the next taxi clearance
          // has to route it out the way it is pointing.
          ac.facingCommitted = ac.heading
          ac.pushFacing = null
        }
      }
      return
    }

    // Under way, so it is no longer bound to a facing it was pushed into — its own heading
    // now carries the same constraint.
    if (!ac.pushingBack && ac.groundspeed > 1) ac.facingCommitted = null

    let remaining = (ac.groundspeed * dt) / 3600
    while (remaining > 1e-9 && ac.leg < ac.path.length - 1) {
      const to = ac.path[ac.leg + 1]
      if (!to) break
      const dx = to[0] - ac.x
      const dy = to[1] - ac.y
      const segLen = Math.hypot(dx, dy)
      if (segLen < 1e-9) {
        ac.leg += 1
        continue
      }
      ac.heading = normalizeDeg(bearing(ac.x, ac.y, to[0], to[1]))
      if (remaining >= segLen) {
        ac.x = to[0]
        ac.y = to[1]
        ac.leg += 1
        remaining -= segLen
      } else {
        ac.x += (dx * remaining) / segLen
        ac.y += (dy * remaining) / segLen
        remaining = 0
      }
    }

    // A push is a swing, not a straight shove: the tug turns the nose toward the direction the
    // aircraft will taxi off in, so it arrives on the alley already pointing that way. Applied
    // after the movement loop, which otherwise leaves the heading along the direction of travel.
    if (ac.pushingBack && ac.pushFacing !== null) {
      const diff = ((ac.pushFacing - ac.heading + 540) % 360) - 180
      const step = Math.min(Math.abs(diff), PUSH_TURN_RATE_DEG_S * dt)
      ac.heading = normalizeDeg(ac.heading + Math.sign(diff) * step)
    }
  }

  /** Assign a freshly computed graph route (node points) to an aircraft. */
  function applyRoute(ac: Internal, routePoints: readonly Point[], dest: Point, appendExact: boolean): void {
    if (routePoints.length === 0) return
    const full: Point[] = [[ac.x, ac.y], ...routePoints]
    if (appendExact) full.push(dest)
    const { path, held } = plan(full)
    ac.path = path
    ac.leg = 0
    ac.held = held
    ac.dwell = -1
    ac.giveWayTo = null // a fresh clearance supersedes any give-way hold
    // A conditional line-up is a clearance about where this aircraft will be in a minute; a
    // taxi clearance is one about where it is going now, and the second supersedes the first.
    // Left armed it would drive onto the runway some time after the controller had sent it
    // somewhere else, off a route they had replaced. The new clearance is the announcement —
    // it is in the transcript, where the old one was.
    ac.lineUpBehind = null
    ac.pushingBack = false // …and aborts an in-progress pushback,
    ac.pushFacing = null // …including the direction it was being swung toward,
    ac.pushFacingLabel = null
    ac.lineUpWait = false // …a line-up on the runway,
    ac.departing = false // …and a takeoff roll — a taxi clearance means it's taxiing now.
    ac.rollWhenLinedUp = false // …including one that hadn't started yet.
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
    ac.holdShort = false
    ac.heldSec = 0
    ac.blockedEdge = null
    // A crossing clearance the aircraft never used is spent by the clearance that replaced it:
    // otherwise "cross, belay that, taxi elsewhere" leaves permission latched at 'issued'
    // forever, and a later uncleared entry would inherit it and never be flagged. Guarded on
    // *not* being on the pavement, because a reroute issued mid-crossing is still the crossing
    // — taking its authority away would ring the aircraft red for obeying us.
    if (!onRunwayNow(ac)) ac.runwayAuth = null
  }

  /** Forget accumulated diversion state — a fresh player clearance supersedes it. */
  function clearDiversion(ac: Internal): void {
    ac.avoidEdges = new Set()
    ac.divertTried = new Set()
  }

  /**
   * The node to route to for a destination. For a runway threshold, this is the hold-short
   * node on the *aircraft's own side* of the runway — so a departure taxis to its runway's
   * threshold rather than routing across the runway to a node that happens to be nearer.
   */
  function goalNodeFor(dest: Point, from: Point): string | null {
    if (!graph) return null
    if (!withinSnap(dest)) return null
    if (guard && onRunway(dest, guard)) {
      let seg: (typeof guard.segments)[number] | null = null
      let best = Infinity
      for (const s of guard.segments) {
        const d = pointSegDist(dest, s.a, s.b)
        if (d < best) {
          best = d
          seg = s
        }
      }
      if (seg) {
        const side = ccw(seg.a, seg.b, from)
        // `side === 0` means `from` sits exactly on the centerline (mid-crossing, or a
        // float coincidence at a threshold) — there is no "own side", so don't let the
        // sign filter go vacuous and fall through to an on-runway node. Just take the
        // nearest off-runway node, honoring goalNodeFor's off-runway hold-short contract.
        const onSide = graph.nearestNodeWhere(dest, (n) =>
          side === 0 ? !onRunway(n, guard) : !onRunway(n, guard) && ccw(seg.a, seg.b, n) * side > 0,
        )
        if (onSide) return onSide
      }
    }
    return graph.nearestNode(dest)
  }

  /**
   * Whether a requested destination is close enough to the movement area to be snapped onto it
   * at all.
   *
   * Snapping is unbounded by nature — `nearestNode` always answers — so without a limit a
   * destination anywhere on earth resolves to *some* node and reads back as an accepted
   * clearance. A backstop, not an aiming tolerance: it is deliberately far looser than anything
   * a controller would click, because legitimate destinations include a stand's stop mark,
   * which sits a lead-in line off the nearest graph node. The UI does its own, tighter test.
   */
  function withinSnap(dest: Point): boolean {
    if (!graph) return false
    const near = graph.nearestNode(dest)
    const p = near ? graph.nodePoint(near) : undefined
    return p !== undefined && dist(p, dest) <= MAX_GOAL_SNAP_NM
  }

  /** Route to a destination. Returns false (nothing applied) when there is no graph or
   *  no path reaches the destination, so the caller can report the refusal. */
  function routeTo(ac: Internal, dest: Point, appendExact: boolean): boolean {
    if (!graph) return false
    const startKey = startNodeFor(ac)
    const goalKey = goalNodeFor(dest, [ac.x, ac.y])
    if (!startKey || !goalKey) return false
    const route = graph.route(startKey, goalKey, committedHeading(ac))
    if (route.length === 0) return false
    clearDiversion(ac)
    applyRoute(ac, route, dest, appendExact)
    return true
  }

  /**
   * The aircraft physically on a stand right now, if any: parked on the mark, whether that is a
   * departure yet to push back or an arrival still dwelling. This is what makes a stand a
   * resource rather than a label — occupancy used to be an emergent property of "no two fleet
   * members share a gate string", which held for the spawner and for nothing else.
   */
  function standOccupant(ref: string, except?: Internal): Internal | undefined {
    const stand = findStand(stands, ref)
    if (!stand) return undefined
    return fleet.find(
      (o) =>
        o !== except &&
        o.gate === ref &&
        !o.airborne &&
        o.groundspeed <= 0.5 &&
        dist([o.x, o.y], stand.stop) < GATE_EPS,
    )
  }

  /**
   * Stands this arrival could be sent to instead — neither occupied nor already spoken for by
   * another aircraft, nearest first. "Spoken for" matters as much as "occupied": two arrivals
   * assigned the same gate is a conflict that has simply not arrived yet.
   */
  function standOptionsFor(ac: Internal): StandOption[] {
    if (ac.intent !== 'arrival') return []
    const from = findStand(stands, ac.gate)
    const origin: Point = from ? from.stop : [ac.x, ac.y]
    const claimed = new Set(fleet.filter((o) => o !== ac).map((o) => o.gate))
    return stands
      .filter((s) => s.ref !== ac.gate && !claimed.has(s.ref) && standOccupant(s.ref, ac) === undefined)
      .map((s) => ({ ref: s.ref, distanceNm: dist(origin, s.stop) }))
      .sort((a, b) => a.distanceNm - b.distanceNm)
  }

  /**
   * Hold short of a stand that is still occupied.
   *
   * Not a refusal: the clearance is good, the aircraft simply cannot have the stand yet. It
   * taxis in, creeps up to the lead-in and waits on the alley until the stand frees, then goes
   * in on its own — which is what makes a late departure at one gate everybody's problem, since
   * the aircraft waiting for it is sitting on the alley in everyone's way.
   */
  function standHoldCap(ac: Internal): number {
    if (ac.gate === null || ac.pushingBack) return Infinity
    const stand = findStand(stands, ac.gate)
    if (!stand) return Infinity
    if (dist([ac.x, ac.y], stand.stop) < GATE_EPS) return Infinity // already on it
    if (!standOccupant(ac.gate, ac)) return Infinity
    const toEntry = dist([ac.x, ac.y], stand.entry)
    if (toEntry > leadLengthNm(stand) + STAND_HOLD_NM) return Infinity // still well out
    // Creep the last stretch, then stop short of the paint.
    return toEntry <= STAND_HOLD_NM ? 0 : STAND_SPEED_KT
  }

  /**
   * Marshalling pace once the aircraft is close enough to its stand to be on the paint.
   *
   * Deliberately positional rather than "the last N legs of the path": the path is rewritten
   * underneath an aircraft by a hold-short split, a crossing release and a congestion diversion,
   * and a leg count captured at clearance time survives none of them — it silently ends up
   * capping the whole taxi route instead of the lead-in.
   */
  function standCap(ac: Internal): number {
    if (ac.pushingBack) return Infinity // the tug sets its own pace
    const stand = standFor(ac)
    if (!stand) return Infinity
    return dist([ac.x, ac.y], stand.stop) <= leadLengthNm(stand) ? STAND_SPEED_KT : Infinity
  }

  /**
   * The push-back path from wherever the aircraft actually is, back down the lead-in.
   *
   * It cannot assume the aircraft is on the nose-stop mark: an arrival stops as soon as it is
   * within `GATE_EPS` of the goal, so it can be parked most of a plane's length short of it.
   * Starting the reversal at the far end of the line would then drag the aircraft sideways onto
   * the paint. Instead the push rejoins the line at the point nearest the aircraft and reverses
   * from there, which is what a tug does.
   */
  function reverseLeadFrom(stand: Stand, from: Point): Point[] {
    let bestSeg = stand.lead.length - 1
    let bestD = Infinity
    for (let i = 1; i < stand.lead.length; i += 1) {
      const d = distToSegment(from, stand.lead[i - 1] as Point, stand.lead[i] as Point)
      if (d <= bestD) {
        bestD = d
        bestSeg = i
      }
    }
    // Everything from the rejoin segment back to the taxilane end, in reverse.
    const back: Point[] = [from]
    for (let i = bestSeg - 1; i >= 0; i -= 1) back.push(stand.lead[i] as Point)
    return back
  }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
  const compassOf = (deg: number): string => COMPASS[Math.round(normalizeDeg(deg) / 45) % 8] as string

  /**
   * The ways off a stand: the alley runs two directions, and the aircraft leaves facing one of
   * them. Which one is a real decision — it cannot turn round on the alley, so the direction it
   * is pushed into is the direction it must taxi off in, and the wrong one can mean a long way
   * round (or no way at all).
   */
  function pushbackOptionsFor(ac: Internal): PushbackOption[] {
    if (!graph) return []
    const stand = standFor(ac)
    const at = stand ? stand.entry : [ac.x, ac.y]
    const key = graph.nearestNode(at as Point)
    if (!key) return []
    const here = graph.nodePoint(key)
    if (!here) return []
    const seen = new Set<string>()
    const opts: PushbackOption[] = []
    for (const n of graph.neighbours(key)) {
      const p = graph.nodePoint(n)
      if (!p) continue
      const headingDeg = normalizeDeg(bearing(here[0], here[1], p[0], p[1]))
      let facing = compassOf(headingDeg)
      // Two ways out that round to the same compass point would be an ambiguous clearance.
      while (seen.has(facing)) facing = `${facing}'`
      seen.add(facing)
      opts.push({ facing, headingDeg, ref: graph.refBetween(key, n) ?? null })
    }
    return opts
  }

  /**
   * With no direction named, push the aircraft the way that serves it: the direction from which
   * its own goal is actually reachable, and if both are, the shorter. This keeps an unspecified
   * pushback sensible rather than arbitrary — and it is what a ramp would do.
   */
  function bestPushDirection(ac: Internal, options: PushbackOption[]): PushbackOption | undefined {
    if (!graph || options.length === 0 || !ac.goalPoint) return options[0]
    const stand = standFor(ac)
    const from = graph.nearestNode((stand ? stand.entry : [ac.x, ac.y]) as Point)
    const to = goalNodeFor(ac.goalPoint, [ac.x, ac.y])
    if (!from || !to) return options[0]
    let best: { opt: PushbackOption; cost: number } | undefined
    for (const opt of options) {
      const path = graph.route(from, to, opt.headingDeg)
      if (path.length === 0) continue
      const cost = pathLength(path)
      if (!best || cost < best.cost) best = { opt, cost }
    }
    return best?.opt ?? options[0]
  }

  /** Length (nm) of a stand's painted lead-in — the zone an aircraft is marshalled through. */
  function leadLengthNm(stand: Stand): number {
    let d = 0
    for (let i = 1; i < stand.lead.length; i += 1) {
      d += dist(stand.lead[i - 1] as Point, stand.lead[i] as Point)
    }
    return d
  }

  /** The stand this aircraft is assigned, when the field has one mapped for its gate. */
  function standFor(ac: Internal): Stand | undefined {
    return findStand(stands, ac.gate)
  }

  /**
   * Route to a gate the way an aircraft actually reaches one: taxi to where the lead-in meets
   * the taxilane, then follow the painted line onto the stand. Routing straight to the stand
   * point instead lets the graph leg cut across the apron and arrive from any direction.
   */
  function routeToStand(ac: Internal, stand: Stand): boolean {
    if (!graph) return false
    const startKey = startNodeFor(ac)
    const goalKey = goalNodeFor(stand.entry, [ac.x, ac.y])
    if (!startKey || !goalKey) return false
    const route = graph.route(startKey, goalKey, committedHeading(ac))
    if (route.length === 0) return false
    clearDiversion(ac)
    applyRoute(ac, [...route, ...stand.lead], stand.stop, false)
    return true
  }

  /** Send an aircraft to its own goal — onto the stand for an arrival with mapped geometry. */
  function routeToOwnGoal(ac: Internal): boolean {
    const stand = ac.intent === 'arrival' ? standFor(ac) : undefined
    // Fall back to the bare goal if the stand's entry is unreachable: `graph.route` is a pure
    // function of the static topology, so a stand-routing failure would fail identically on
    // every retry and leave the arrival circling the same refusal forever.
    if (stand && routeToStand(ac, stand)) return true
    return ac.goalPoint ? routeTo(ac, ac.goalPoint, true) : false
  }

  /** Route via an ordered taxiway sequence, falling back to shortest path if that
   *  exact sequence can't reach the destination (so a bad clearance still taxis).
   *  Returns false when no route could be applied at all. */
  function routeVia(ac: Internal, taxiways: readonly string[], dest: Point, appendExact: boolean): boolean {
    if (!graph) return false
    const startKey = startNodeFor(ac)
    const goalKey = goalNodeFor(dest, [ac.x, ac.y])
    if (!startKey || !goalKey) return false
    const head = committedHeading(ac)
    const via = graph.routeVia(startKey, goalKey, taxiways, head)
    const route = via.length > 0 ? via : graph.route(startKey, goalKey, head)
    if (route.length === 0) return false
    clearDiversion(ac)
    applyRoute(ac, route, dest, appendExact)
    return true
  }

  const ACCEPTED: DispatchResult = { ok: true }
  const refused = (reason: string): DispatchResult => ({ ok: false, reason })

  /**
   * Taxi onto the runway centerline in front of the aircraft (the nearest point, not its far
   * departure-runway goal — so it lines up where it is holding, at either end).
   */
  function enterRunway(ac: Internal): void {
    clearDiversion(ac)
    ac.path = lineUpPath(ac)
    ac.leg = 0
    ac.held = null
    ac.holdShort = false
    ac.lineUpWait = true
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
  }

  /**
   * Begin the takeoff roll. Only ever called with the aircraft already on the centerline —
   * either because it was lined up and waiting, or because it has just taxied into position.
   * Rolling from wherever the aircraft happened to be standing is what made a departure cleared
   * from hold-short accelerate at takeoff power diagonally off the taxiway and onto the runway.
   */
  function beginTakeoffRoll(ac: Internal): boolean {
    const r = activeRunwayFor(ac)
    const far = r ? takeoffEnd(r) : farRunwayEnd([ac.x, ac.y])
    if (!far) return false
    clearDiversion(ac)
    ac.path = [[ac.x, ac.y], far]
    ac.leg = 0
    ac.held = null
    ac.lineUpWait = false
    ac.rollWhenLinedUp = false
    ac.departing = true
    ac.targetSpeed = TAKEOFF_SPEED_KT
    ac.holding = false
    ac.holdShort = false
    // The wake-separation clock starts when the roll does, not when the clearance was issued.
    // Recorded against the runway it rolls from, so it gates only that runway's next departure.
    lastDepartureByRunway.set(targetRunwayId(ac) ?? '', { wake: ac.wake, atTime: time })
    return true
  }

  /** A departure cleared from hold-short rolls the moment it is established on the centerline. */
  function resolveLineUp(ac: Internal): void {
    if (!ac.rollWhenLinedUp || !ac.lineUpWait) return
    if (ac.leg < ac.path.length - 1) return
    beginTakeoffRoll(ac)
  }

  /**
   * A direction the aircraft cannot route against.
   *
   * Under way, that is simply its heading — it cannot turn round on a taxiway mid-taxi. Stopped,
   * it is whatever direction it was pushed back into, which is the whole point of choosing one.
   * Otherwise undefined: a stationary aircraft that has not been pushed may set off either way.
   */
  function committedHeading(ac: Internal): number | undefined {
    if (ac.pushingBack || ac.departing || ac.airborne) return undefined
    if (ac.facingCommitted !== null) return ac.facingCommitted
    // Standing on a stand, or freshly placed, with no route of its own: nothing binds it yet —
    // it gets pushed or towed onto the taxiway facing wherever it needs to.
    if (ac.groundspeed <= 1 && ac.path.length < 2) return undefined
    // Anything else on the surface is committed to the way it is pointing, *including while
    // stopped*. Deriving this from live groundspeed instead meant a hold — the ordinary way a
    // taxi clearance gets revisited, whether from the controller, a give-way or a reservation —
    // silently released the aircraft to turn round on the spot.
    return ac.heading
  }

  /**
   * Where a route starts from on the graph.
   *
   * Not simply the nearest node: an aircraft committed to a direction may have the nearest node
   * *behind* it, and joining the graph there would have it reverse off the stand before setting
   * off. The turn limit constrains the route once it is on the graph; this applies the same
   * limit to getting onto it. Falls back to the nearest node when nothing lies ahead, so a
   * committed heading can never strand an aircraft outright.
   */
  function startNodeFor(ac: Internal): string | null {
    if (!graph) return null
    const head = committedHeading(ac)
    if (head === undefined) return graph.nearestNode([ac.x, ac.y])
    // No fallback to the plain nearest node: that node can be *behind* the aircraft, and the
    // join leg from its position onto the graph is drawn as a raw straight line with no turn
    // accounting — so falling back would reverse the aircraft onto the graph and reopen the
    // very defect this closes, at the seam between off-graph position and on-graph route.
    // Nothing ahead means no route, which the caller reports as a refusal.
    return graph.nearestNodeWhere([ac.x, ac.y], (n) => {
      const to = normalizeDeg(bearing(ac.x, ac.y, n[0], n[1]))
      return Math.abs((((to - head + 540) % 360) - 180)) <= MAX_TURN_DEG
    })
  }

  /** The named taxiways an aircraft's current route follows, in order. */
  function taxiwaysFor(ac: Internal): string[] {
    if (!graph) return []
    const out: string[] = []
    let prevKey: string | null = null
    for (const p of ac.path) {
      const k = graph.keyAt(p)
      if (!k) {
        prevKey = null
        continue
      }
      if (prevKey) {
        const ref = graph.refBetween(prevKey, k)
        if (ref && out[out.length - 1] !== ref) out.push(ref)
      }
      prevKey = k
    }
    return out
  }

  /** Surface-movement commands. Dispatched to an aircraft in the air they are not merely
   *  meaningless but destructive — `hold` would stop it dead on final (never landing, never
   *  going around, blocking the runway forever) and a taxi clearance would drive an aircraft
   *  still flagged airborne along a graph route. The sim refuses them itself; the menu's
   *  phase gating is a convenience, not the authority. */
  const GROUND_ONLY: ReadonlySet<GroundCommand['type']> = new Set([
    'taxiTo',
    'taxiToGoal',
    'taxiVia',
    'taxiViaGoal',
    'hold',
    'resume',
    'giveWay',
    'expedite',
  ])

  /**
   * Apply a command, then — only if it was accepted — put it on the air. Logging here rather
   * than at each `return ACCEPTED` means a new command cannot be added without a transcript,
   * and a refused one can never appear as though it had been transmitted.
   */
  function dispatch(command: GroundCommand): DispatchResult {
    const ac = find(command.aircraftId)
    const issuedBy = ac?.controlledBy ?? 'ground'
    const before = situationBefore(ac)
    // Captured before the command runs: applying a "say again" is what clears the mismatch, so
    // afterwards there is no way to tell whether this call was the one that fixed a code.
    const unverified = ac ? squawkUnverified(ac) : false
    const result = applyCommand(command)
    if (result.ok && ac) {
      // Anything said to an aircraft answers it. The clock is "how long since anyone spoke to
      // this one", so a handoff resets it even though the aircraft is now waiting for the next
      // instruction — otherwise the aircraft you have just dealt with keeps its old number and
      // goes on being reported as neglected.
      ac.awaitingSec = 0
      if (command.type === 'sayAgain') {
        logCorrection(ac, issuedBy, unverified)
        return result
      }
      logExchange(command, ac, issuedBy, before)
      // A handoff that took effect immediately: the pilot checks in on the new frequency.
      if (command.type === 'contactTower') checkIn(ac)
      // "…contact ground" issued once already clear of the runway takes effect at once.
      if (command.type === 'contactGround' && ac.controlledBy === 'ground') checkIn(ac)
    }
    return result
  }

  function applyCommand(command: GroundCommand): DispatchResult {
    const ac = find(command.aircraftId)
    if (!ac) return refused(`unknown aircraft "${command.aircraftId}"`)
    if (ac.airborne && GROUND_ONLY.has(command.type)) return refused('aircraft is airborne')
    switch (command.type) {
      case 'taxiTo':
        return routeTo(ac, command.dest, command.exact ?? false)
          ? ACCEPTED
          : refused('no taxi route to that point')
      case 'taxiToGoal':
        // Append the exact goal so departures hold short at the runway and
        // arrivals park at the stand (rather than stopping at the nearest node).
        if (!ac.goalPoint) return refused('aircraft has no assigned goal')
        return routeToOwnGoal(ac) ? ACCEPTED : refused('no taxi route to the goal')
      case 'taxiVia':
        return routeVia(ac, command.taxiways, command.dest, command.exact ?? false)
          ? ACCEPTED
          : refused('no taxi route via those taxiways')
      case 'taxiViaGoal':
        if (!ac.goalPoint) return refused('aircraft has no assigned goal')
        return routeVia(ac, command.taxiways, ac.goalPoint, true)
          ? ACCEPTED
          : refused('no taxi route via those taxiways')
      case 'pushback': {
        // Ease the aircraft off the stand onto the nearest taxilane node (the alley),
        // then it's ready to taxi. Departures only, only from a stationary aircraft that
        // is still at its gate (a single-point route) — refused once routed or moving.
        if (ac.intent !== 'departure') return refused('only departures push back')
        if (!graph) return refused('no taxi graph')
        if (ac.pushingBack) return refused('already pushing back')
        if (ac.groundspeed > 0.1 || ac.path.length > 1) return refused('already moving or routed')
        const svc = serviceRemaining(ac)
        if (svc > 0) return refused(`ground servicing in progress — ${Math.ceil(svc)}s to pushback`)
        // Which way it ends up facing. Named, because it decides which way the aircraft can
        // taxi off: it cannot turn round on the alley. Unspecified, the tug picks whichever
        // direction actually serves this aircraft's goal.
        const options = pushbackOptionsFor(ac)
        let facing: PushbackOption | undefined
        if (command.facing !== undefined) {
          facing = options.find((o) => o.facing.toUpperCase() === command.facing!.toUpperCase())
          if (!facing) {
            const names = options.map((o) => o.facing).join(' or ')
            return refused(names ? `unable — push back facing ${names}` : 'nowhere to push back to')
          }
        } else {
          facing = bestPushDirection(ac, options)
        }

        // Push back the way the aircraft came in: reversed along its own lead-in line, which
        // ends on the taxilane. Shoving toward the nearest graph node instead is what sent
        // aircraft backing off the stand in directions the paint never goes.
        const stand = standFor(ac)
        const back: Point[] = stand
          ? reverseLeadFrom(stand, [ac.x, ac.y])
          : (() => {
              const alleyKey = graph.nearestNode([ac.x, ac.y])
              const alley = alleyKey ? graph.nodePoint(alleyKey) : undefined
              return alley ? [[ac.x, ac.y] as Point, alley] : []
            })()
        const target = back[back.length - 1]
        if (back.length < 2 || !target || dist([ac.x, ac.y], target) < GATE_EPS)
          return refused('no alley to push onto')
        clearDiversion(ac)
        ac.path = back
        ac.leg = 0
        ac.held = null
        ac.dwell = -1
        ac.pushingBack = true
        ac.pushFacing = facing ? facing.headingDeg : null
        ac.pushFacingLabel = facing ? facing.facing : null
        ac.facingCommitted = null
        ac.targetSpeed = PUSHBACK_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        return ACCEPTED
      }
      case 'hold':
        ac.targetSpeed = 0
        return ACCEPTED
      case 'resume': {
        // "Continue taxi" continues something. An aircraft at the end of its route — an arrival
        // that has just checked in with Ground and been issued nothing, most of all — has no
        // clearance to run, and accepting the instruction anyway is how a frequency change came
        // to look like it had also sent the aircraft somewhere. A give-way is still cancellable:
        // that *is* the hold being lifted.
        const hasRoute = ac.leg < ac.path.length - 1
        if (!hasRoute && !ac.giveWayTo) return refused('nothing to continue — no clearance to run')
        ac.giveWayTo = null // "continue taxi" also cancels a give-way hold
        if (hasRoute) {
          ac.targetSpeed = TAXI_SPEED_KT
          ac.holding = false
        }
        return ACCEPTED
      }
      case 'giveWay': {
        const target = find(command.toId)
        if (!target || target === ac) return refused('unknown or self give-way target')
        ac.giveWayTo = command.toId
        return ACCEPTED
      }
      case 'crossRunway':
        // Deliberately no `controlledBy` gate, unlike lineUpAndWait/clearedForTakeoff: a
        // crossing is legitimately either position's to issue (docs/atc-runway-crossing.md §5),
        // and the sim has no notion of *who* is dispatching — `issuedBy` is taken from whoever
        // owns the aircraft. The owner is the issuer by construction, so there is nothing to gate.
        if (!ac.held || ac.held.length < 2) return refused('not holding short of a runway')
        // A clearance to cross has to have a far side to reach. Without this an aircraft cleared
        // *to* the runway would be driven onto it and parked there — see `heldRouteCrosses`.
        if (!heldRouteCrosses(ac))
          return refused('that route does not cross the runway — it ends on it')
        // Don't clear onto an occupied runway — any runway this route crosses. If the crossed
        // runway can't be resolved (a held route straddles the centerline without a vertex on
        // it), fall back to the field-wide check: conservative, and exactly the single-runway
        // behaviour, so we never trade a real occupancy refusal for an unresolved id.
        if (guard) {
          const crossed = crossedRunwayIds(ac)
          const blocked =
            crossed.length === 0
              ? fleet.some((o) => o !== ac && blocksRunway(o))
              : fleet.some((o) => o !== ac && crossed.some((r) => blocksRunwayFor(o, r, 'occupancy')))
          if (blocked) return refused('runway occupied')
        }
        clearDiversion(ac)
        ac.path = ac.held
        ac.leg = 0
        ac.held = null
        ac.runwayAuth = 'issued' // …and it is now permitted on the pavement, until it is off it
        ac.targetSpeed = TAXI_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        return ACCEPTED
      case 'goAround':
        // Deliberately not gated on holding a landing clearance: an arrival still awaiting one
        // is exactly the aircraft you most want to turn away early, and refusing it there would
        // make the lever unavailable in half the situations it exists for.
        if (ac.intent !== 'arrival' || !ac.airborne)
          return refused('only an arrival on final can be sent around')
        if (!reestablishOnFinal(ac)) return refused('no approach to re-fly')
        return ACCEPTED
      case 'expedite': {
        // "Expedite" runs the clearance the aircraft already has, so there has to be one left
        // to run. Refusing here rather than silently accepting keeps the alert honest: if the
        // occupant cannot be hurried, the answer is the go-around instead.
        if (!canExpedite(ac)) return refused('nothing to expedite — no clearance to run')
        ac.giveWayTo = null // the opposite instruction — you cannot hurry and wait at once
        ac.targetSpeed = EXPEDITE_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        return ACCEPTED
      }
      case 'holdShort': {
        if (onRunwayNow(ac)) return refused('already on the runway — too late to hold short')
        // A conditional line-up is a clearance the aircraft has not acted on yet, so this is
        // exactly the instruction that takes it back — the same way it takes back a crossing.
        ac.lineUpBehind = null
        if (!canHoldShortNow(ac)) return refused('no runway ahead to hold short of')
        // Already stopping at the line: this is a confirmation, and the answer to "ready to
        // cross" when the answer is no. Nothing to change — saying it *is* the instruction.
        if (ac.held) return ACCEPTED
        // Otherwise it holds a crossing clearance it has not used. Take it back.
        if (!reholdAtRunway(ac)) return refused('no runway ahead to hold short of')
        ac.runwayAuth = null // …and the permission that came with it
        return ACCEPTED
      }
      case 'sayAgain':
        // Refused only when there is nothing to repeat *and* no code to verify — never because
        // the read-back happened to be correct, which would turn the mechanic into a free
        // answer. The second half is not redundant: a clearance can stop being repeatable on
        // its own (a give-way that clears itself when the traffic passes, a handoff that ends
        // the position's business with the aircraft), and a transponder set to the wrong code
        // is not repaired by that. Without it an aircraft could be left squawking a code
        // nobody issued, refused the handoff for it, and with no instruction left that fixes
        // it — stuck at the hold-short line for the rest of the session.
        if (!ac.lastClearance && !squawkUnverified(ac))
          return refused('nothing has been issued to that aircraft')
        correctMishearing(ac)
        return ACCEPTED
      case 'assignStand': {
        // The lever the gate alert would otherwise leave you without. Everything is validated
        // before anything is mutated — including the reroute, which is rolled back if it fails,
        // so a refused reassignment never leaves the aircraft pointed at a gate it can't reach.
        if (ac.intent !== 'arrival') return refused('only arrivals are assigned a stand')
        const stand = findStand(stands, command.ref)
        if (!stand) return refused(`unknown stand "${command.ref}"`)
        if (ac.gate === command.ref) return refused(`already assigned gate ${command.ref}`)
        const occupant = standOccupant(command.ref, ac)
        if (occupant) return refused(`gate ${command.ref} occupied by ${occupant.callsign}`)
        const claimant = fleet.find((o) => o !== ac && o.gate === command.ref)
        if (claimant) return refused(`gate ${command.ref} assigned to ${claimant.callsign}`)

        const prevGate = ac.gate
        const prevGoal = ac.goalPoint
        ac.gate = command.ref
        ac.goalPoint = stand.stop
        // Already taxiing to the old gate: send it to the new one now, rather than leaving it
        // driving to a stand it is no longer assigned.
        if (!ac.airborne && ac.path.length > 1 && !routeToStand(ac, stand)) {
          ac.gate = prevGate
          ac.goalPoint = prevGoal
          return refused(`no taxi route to gate ${command.ref}`)
        }
        return ACCEPTED
      }
      case 'clearance':
        // Clearance delivery: issue the IFR clearance to a departure, assigning a beacon
        // code. Gates pushback — a gate departure can't push until it's been cleared.
        if (ac.intent !== 'departure') return refused('only departures receive IFR clearance')
        if (ac.squawk) return refused('already cleared')
        ac.squawk = nextSquawk()
        ac.issuedSquawk = ac.squawk
        maybeSlot(ac)
        return ACCEPTED
      case 'contactTower': {
        // Ground → Tower handoff: transfer a departure holding short of its own runway to
        // Local Control (Tower). A frequency change only — it stays holding short, and Tower
        // then issues line-up-and-wait / takeoff clearance. No runway or wake gate here; those
        // gate the takeoff clearance itself (see docs/atc-tower.md).
        if (ac.controlledBy === 'tower') return refused('already on tower frequency')
        if (!ac.holdShort) return refused('not holding short of the runway')
        // Two reasons to be handed off from a hold-short line, and Local Control owns the runway
        // for both of them: a departure about to use the runway, or a transit about to cross it
        // ("contact Tower for runway 27 crossing" — docs/atc-runway-crossing.md §5, option B).
        // An arrival crosses to reach its gate, so this is deliberately not departures-only.
        if (!holdingForTakeoff(ac) && !heldRouteCrosses(ac))
          return refused('nothing to hand off for — not a takeoff or a crossing')
        // What a missed read-back finally costs. The aircraft is squawking a code the
        // controller never issued, and this is the last moment Ground owns it: handing it on is
        // handing the next position an aircraft it cannot identify. Deliberately not a gate on
        // the *clearance* — that would catch the error for you, and noticing it in the
        // transcript is the whole game (see `maybeMishear`). It is also not a gate on a
        // crossing: a transit is coming straight back, and nothing is about to look for it on
        // radar. "Say again" is the fix, and the delay is the price of not having noticed.
        // NOTE (multi-runway): `holdingForTakeoff` keys off the *goal* sitting on a runway,
        // while its sibling `heldRouteCrosses` keys off the held route. On a single-runway
        // field the two cannot disagree. On a field where a departure crosses one runway to
        // reach another, an aircraft holding short of the *crossing* would still answer "yes"
        // here — gating a crossing this deliberately exempts. Fix by deriving it from the held
        // route's endpoint, with the rest of the multi-runway work (docs/adding-an-airport.md).
        if (squawkUnverified(ac) && holdingForTakeoff(ac))
          return refused('verify transponder code — the read-back was never checked')
        ac.controlledBy = 'tower'
        return ACCEPTED
      }
      case 'lineUpAndWait': {
        // Tower: taxi a handed-off departure onto the runway centerline and hold, awaiting
        // takeoff clearance. Requires a clear runway; lining up then occupies it.
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency — hand off to tower first')
        if (ac.intent !== 'departure') return refused('only departures line up and wait')
        if (!ac.holdShort) return refused('not holding short of the runway')
        if (guard && (!ac.goalPoint || !onRunway(ac.goalPoint, guard)))
          return refused('route crosses the runway — clear it to cross, not to line up')
        const cannotRoll = takeoffBlocked(ac)
        if (cannotRoll) return refused(cannotRoll)
        // Conditional: "behind the landing 737, line up and wait, behind". Nothing happens now.
        // The runway gate below is deliberately *not* applied at issue — the runway is occupied,
        // that is the entire premise — and is applied instead at the moment the condition comes
        // true, against the situation as it is then.
        if (command.behind !== undefined) {
          const traffic = find(command.behind)
          if (!traffic || traffic === ac) return refused('unknown traffic')
          if (traffic.intent !== 'arrival' || !traffic.airborne || !traffic.clearedToLand) {
            return refused('that traffic is not cleared to land')
          }
          ac.lineUpBehind = traffic.id
          return ACCEPTED
        }
        // Traffic that is *moving away* down the runway does not block a line-up behind it —
        // that is precisely what "line up and wait" is for. A departure rolling, and equally a
        // landing rolling out, are both leaving: docs/atc-operations.md §6 gives the rollout as
        // the reason the instruction exists ("the runway is not quite clear — a landing aircraft
        // is still rolling out"). Anything *stationary* on the pavement still blocks, including
        // a rollout that has stopped on it, because that one is not leaving at all.
        //
        // "On its way into position" counts as in position: an aircraft cleared to line up is
        // committed to the runway from the clearance, not from the moment its wheels reach the
        // centerline. Without that, two aircraft dispatched in the same tick were both accepted
        // — neither was physically on the runway yet, and both were told to taxi onto it.
        //
        // (Line-up uses this "moving away" bar; the takeoff clearance keeps the stricter
        // "rotated" one — see clearedForTakeoff. That difference is the whole value of lining
        // up early rather than merely earlier.)
        if (!canLineUpNow(ac)) return refused('runway occupied')
        enterRunway(ac)
        return ACCEPTED
      }
      case 'clearedForTakeoff': {
        // Tower: release a departure for the takeoff roll — directly from holding short (the
        // fast path) or from line-up-and-wait. It accelerates to the far runway end and lifts
        // off (despawns as a completed departure). Requires a clear runway and satisfied wake
        // interval; those gates live here now, not at the handoff.
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency — hand off to tower first')
        if (ac.intent !== 'departure') return refused('only departures are cleared for takeoff')
        if (ac.rollWhenLinedUp) return refused('already cleared for takeoff — taxiing into position')
        if (!ac.holdShort && !ac.lineUpWait) return refused('not holding short or lined up')
        if (guard && (!ac.goalPoint || !onRunway(ac.goalPoint, guard)))
          return refused('route crosses the runway — clear it to cross, not for takeoff')
        // Enough runway ahead to actually get airborne. This is what stops an aircraft at the
        // wrong end being launched into a few hundred feet of pavement and then the grass.
        const blocked = takeoffBlocked(ac)
        if (blocked) return refused(blocked)
        // The runway must be clear of blocking traffic — its own runway — but a preceding
        // departure that has rotated (near liftoff) no longer blocks, so the next may be cleared
        // behind it.
        if (guard && fleet.some((o) => o !== ac && blocksRunwayFor(o, targetRunwayId(ac), 'occupancy')))
          return refused('runway occupied')
        // Wake-turbulence hold: a following departure can't roll until the interval behind
        // the previous departure *on its own runway* has elapsed (see docs/wake-turbulence.md).
        const leader = wakeLeaderFor(ac)
        if (leader) {
          const required = wakeSeparationSec(leader.wake, ac.wake) * WAKE_TIME_SCALE
          const remaining = required - (time - leader.atTime)
          if (remaining > 0) {
            const category = leader.wake === 'J' ? 'Super' : 'Heavy'
            return refused(`wake turbulence — ${Math.ceil(remaining)}s behind ${category}`)
          }
        }
        // The wheels-up window, checked last of the gates: it is the only one that is about the
        // clock rather than about the runway, so an aircraft refused for it is otherwise ready
        // to go — which is exactly the hold the docs describe, and exactly why it is expensive.
        const slot = slotState(ac)
        if (slot === 'early') {
          return refused(`EDCT ${clockTime(ac.edctSec!)} — ${Math.ceil(ac.edctSec! - EDCT_EARLY_SEC - time)}s to the window`)
        }
        if (slot === 'late') {
          // Missed. The real answer is a new time negotiated with flow; here it is issued, and
          // the aircraft goes on sitting at the runway in everyone else's way. Counted once —
          // the second attempt is the same missed slot, not a second one.
          slotsMissed += 1
          ac.edctSec = nextSlot(EDCT_PENALTY_MIN_SEC, EDCT_PENALTY_MAX_SEC)
          transmit('controller', ac.controlledBy, ac, `${ac.callsign}, slot missed, new EDCT ${clockTime(ac.edctSec)}.`)
          transmit('pilot', ac.controlledBy, ac, `New EDCT ${clockTime(ac.edctSec)}, ${ac.callsign}.`)
          return refused(`slot missed — new EDCT ${clockTime(ac.edctSec)}`)
        }
        if (slot === 'open') {
          // Met at the clearance rather than at wheels-up: the roll is seconds, the clearance is
          // the commitment, and refusing one for a window the aircraft would miss by four
          // seconds is a rule about arithmetic (docs/atc-flight-cycle.md).
          slotsMet += 1
          ac.edctSec = null
        }
        // Already lined up: apply power now. Still holding short: this is "taxi into position
        // and roll" — it taxis onto the centerline first and the roll starts on arrival. The
        // clearance is one transmission either way; only the geometry differs.
        if (!runway && !farRunwayEnd([ac.x, ac.y])) return refused('no runway end found')
        if (ac.lineUpWait) return beginTakeoffRoll(ac) ? ACCEPTED : refused('no runway end found')
        enterRunway(ac)
        ac.rollWhenLinedUp = true
        return ACCEPTED
      }
      case 'assignExit': {
        // Tower assigns the turnoff — on final (planning ahead) or during the rollout (a
        // change of plan, which re-solves the braking). Refused for a turnoff the aircraft
        // cannot slow down enough to make, which is the real constraint.
        if (ac.intent !== 'arrival') return refused('only arrivals are assigned a runway exit')
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency')
        if (ac.vacated) return refused('already clear of the runway')
        const option = exitOptionsFor(ac).find((e) => e.ref === command.ref)
        if (!option) return refused(`unable ${command.ref} — cannot slow down in time`)
        // Re-solving mid-roll can fail even though the exit looked reachable: the corners
        // inside the connector bind harder than its entrance does.
        if (ac.rollingOut && !planExitRoll(ac, option))
          return refused(`unable ${command.ref} — too fast for that turn`)
        ac.assignedExitRef = option.ref
        return ACCEPTED
      }
      case 'contactGround': {
        // Tower → Ground. Issued before the aircraft is clear it is the real-world "when
        // vacated / when clear of the runway, contact ground": it arms the change, which takes
        // effect the moment the aircraft actually is clear. A pilot never switches frequency
        // unprompted, so nothing else does.
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency')
        if (ac.airborne) return refused('still airborne')
        if (ac.groundPending) return refused('already sent to ground')
        // The other way Tower holds a surface aircraft: it took the handoff for a crossing and
        // gives it back once the aircraft is across. Nothing is re-routed — unlike an arrival
        // off the runway, a transit is already taxiing the clearance it was given.
        if (!ac.rollingOut) {
          // Only a crossing. A line-up or a takeoff roll is Tower's until it is airborne, and
          // handing one to Ground would strand it on the runway on the wrong frequency.
          if (!onCrossing(ac)) return refused('committed to the runway — not a crossing')
          if (onRunwayNow(ac)) {
            ac.groundPending = true // still on the pavement: "when clear of the runway…"
            return ACCEPTED
          }
          ac.controlledBy = 'ground'
          voidClearance(ac)
          return ACCEPTED
        }
        if (ac.intent !== 'arrival') return refused('only arrivals are handed to ground after landing')
        // Arm the change only if it isn't applicable yet; a failed immediate handoff must not
        // leave the aircraft looking "already sent" when it was actually refused.
        if (ac.vacated) {
          handOffToGround(ac)
          return ACCEPTED
        }
        ac.groundPending = true
        return ACCEPTED
      }
      case 'clearedToLand': {
        // Tower: clear an arrival on final to land. The clearance is an arming — the aircraft
        // keeps flying the same final, but will now touch down at the threshold instead of
        // going around. Refused onto a runway that is occupied or committed to someone else.
        if (ac.intent !== 'arrival') return refused('only arrivals are cleared to land')
        if (!ac.airborne) return refused('not on final')
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency')
        if (ac.clearedToLand) return refused('already cleared to land')
        if (guard && fleet.some((o) => o !== ac && blocksRunwayFor(o, targetRunwayId(ac), 'occupancy')))
          return refused('runway occupied')
        ac.clearedToLand = true
        return ACCEPTED
      }
    }
  }

  /**
   * Touchdown: the arrival stops flying and becomes a surface aircraft decelerating along the
   * runway toward the far end. It stays Tower's until it can leave the runway.
   */
  function touchdown(ac: Internal): void {
    // The landing clearance is spent the moment it is used; from here the aircraft is on a
    // rollout, and "say again" must not re-transmit a clearance to land.
    voidClearance(ac, 'clearedToLand')
    ac.airborne = false
    ac.altitude = 0
    ac.rollingOut = true
    ac.vacated = false
    ac.held = null
    ac.holding = false
    // `threshold` is deliberately kept: it is the landing threshold every exit distance and
    // rollout re-plan is measured from.
    planRollout(ac)
  }

  /**
   * Aim the rollout at a turnoff. The aircraft drives the connector's **real polyline**, not the
   * chord between its endpoints — cutting the corner both looks wrong and hides the curve that
   * limits the speed. The braking rate is then solved against every corner ahead, so the
   * aircraft arrives at each one already slow enough for it.
   *
   * Returns false when the turnoff cannot be made from here without braking harder than
   * {@link MAX_BRAKE_KT_S}: the aircraft declines it rather than taking a turn too fast.
   */
  function planExitRoll(ac: Internal, e: RunwayExit): boolean {
    const path: Point[] = [[ac.x, ac.y], ...e.geom]
    const limits = turnSpeedLimits(path)
    // The corner where it leaves the runway is the turnoff's own rating: the raw polyline
    // deflection there understates it, because the fillet is rarely surveyed (see FILLET_NM).
    limits[1] = Math.min(limits[1] ?? Infinity, e.speedKt)
    limits[limits.length - 1] = 0 // it comes to a stop clear of the runway
    if (cannotMake(ac.groundspeed, [ac.x, ac.y], path, limits, 0, MAX_BRAKE_KT_S)) return false
    const required = requiredBrakeRate(ac.groundspeed, [ac.x, ac.y], path, limits)
    ac.exit = e
    ac.speedLimits = limits
    ac.brakeRate = Math.min(MAX_BRAKE_KT_S, Math.max(MIN_BRAKE_KT_S, required))
    ac.path = path
    ac.leg = 0
    ac.held = null
    // A rollout only ever slows down: the turnoff's rating is a ceiling, not a goal, so an
    // aircraft already slower than it must not accelerate back up to take the turn.
    ac.targetSpeed = Math.min(ac.groundspeed, e.speedKt)
    ac.holding = false
    return true
  }

  /** Roll straight ahead to the far end: no turnoff can be made, so keep braking on the
   *  centerline and let the controller (or the next re-plan) sort it out. */
  function planStraightRoll(ac: Internal): void {
    const far = farRunwayEnd([ac.x, ac.y])
    ac.exit = null
    ac.speedLimits = []
    ac.brakeRate = ROLLOUT_DECEL
    ac.path = far ? [[ac.x, ac.y], far] : [[ac.x, ac.y]]
    ac.leg = 0
    ac.targetSpeed = Math.max(ac.groundspeed, TAXI_SPEED_KT)
  }

  /**
   * Choose and plan the turnoff: the assigned one if it can still be made, else the one that
   * frees the runway soonest, else — walking outward — any turnoff at all, else straight ahead.
   * This is the "unable, we'll take the next one" fall-through: an aircraft that is too fast for
   * the turnoff it was planning declines it and continues instead of wrenching off at speed.
   */
  /** Which side of the landing runway this arrival's gate is on — so the rollout turns off toward
   *  the terminal rather than away from it. Undefined when it does not apply (a departure, no goal,
   *  or no resolvable runway), leaving the choice on rollout time alone. The sign convention matches
   *  `buildRunwayExits`' `turn`: cross(landing-direction, gate − threshold) > 0 is a left exit. */
  function gateSideFor(ac: Internal): 'left' | 'right' | undefined {
    if (ac.intent !== 'arrival' || !ac.goalPoint) return undefined
    const rwy = activeRunwayFor(ac)
    if (!rwy) return undefined
    const ux = rwy.farEnd[0] - rwy.threshold[0]
    const uy = rwy.farEnd[1] - rwy.threshold[1]
    if (Math.hypot(ux, uy) < 1e-9) return undefined
    const gx = ac.goalPoint[0] - rwy.threshold[0]
    const gy = ac.goalPoint[1] - rwy.threshold[1]
    return ux * gy - uy * gx > 0 ? 'left' : 'right'
  }

  function planRollout(ac: Internal): void {
    const options = exitOptionsFor(ac)
    const assigned = options.find((e) => e.ref === ac.assignedExitRef)
    const preferred = chooseExit(
      options,
      ac.groundspeed,
      alongRunway(ac.threshold ?? [ac.x, ac.y], [ac.x, ac.y]),
      gateSideFor(ac),
    )
    for (const candidate of [assigned, preferred, ...options]) {
      if (candidate && planExitRoll(ac, candidate)) return
    }
    planStraightRoll(ac)
  }

  /**
   * Go around — the stub version: an arrival that reaches the threshold without a landing
   * clearance is re-established at the final fix and flies the approach again. The real
   * version climbs out and re-enters TRACON sequencing (docs/atc-tower.md, Slice 3).
   */
  function reestablishOnFinal(ac: Internal): boolean {
    const fix = ac.path[0]
    if (!fix) return false
    ac.x = fix[0]
    ac.y = fix[1]
    ac.leg = 0
    ac.altitude = ac.finalAltFt
    ac.groundspeed = ac.targetSpeed
    ac.clearedToLand = false
    ac.exit = null
    ac.assignedExitRef = null
    const next = ac.path[1]
    if (next) ac.heading = normalizeDeg(bearing(fix[0], fix[1], next[0], next[1]))
    return true
  }

  /** The go-around the *pilot* calls: reaching the threshold with no landing clearance. It is
   *  announced, not cleared, and it voids the landing clearance so that clearance is no longer
   *  repeatable. The controller-issued one is the `goAround` command, which shares the state
   *  change above but is transmitted the other way round — as an instruction with a read-back. */
  function goAround(ac: Internal): void {
    if (!reestablishOnFinal(ac)) return
    voidClearance(ac)
    transmit('pilot', 'tower', ac, `${ac.callsign}, going around.`)
  }

  /**
   * Tower → Ground handoff for a landed arrival: a **frequency change, and nothing else**.
   *
   * The aircraft has already cleared the runway on its landing rollout — vacating is the end of
   * the landing, which the pilot does without being told. What it does not have is anywhere to
   * go: it stops clear of the runway on Ground's frequency, checks in ("clear of the runway at
   * Bravo"), and waits. Ground taxis it to the gate as a separate instruction, because that is
   * a separate instruction — this used to route it to its stand as a side effect of the
   * handoff, which made "contact ground" silently mean "and taxi to the gate" and left the
   * position with nothing to actually do.
   */
  function handOffToGround(ac: Internal): void {
    ac.rollingOut = false
    // It stops being a rollout the moment Ground has it, but it is still on the pavement and
    // still entitled to be — the taxi off the runway is the end of the landing, not a new entry.
    ac.runwayAuth = 'on'
    ac.groundPending = false
    ac.controlledBy = 'ground'
    // Tower's business with this aircraft is finished; Ground has issued it nothing yet.
    voidClearance(ac)
  }

  /**
   * Speed cap for a rollout: fast enough to keep rolling, slow enough that every corner still
   * ahead is met at its own limit. If even maximum braking can no longer achieve that — the
   * aircraft is simply too fast for the turnoff it was planning — it declines and re-plans
   * ("unable, we'll take the next one") rather than taking the turn dangerously.
   */
  function rolloutCap(ac: Internal): number {
    if (ac.speedLimits.length === 0) return Infinity
    if (cannotMake(ac.groundspeed, [ac.x, ac.y], ac.path, ac.speedLimits, ac.leg, MAX_BRAKE_KT_S)) {
      planRollout(ac)
      if (ac.speedLimits.length === 0) return Infinity
    }
    return profileCap([ac.x, ac.y], ac.path, ac.speedLimits, ac.leg, ac.brakeRate)
  }

  /**
   * Apply a "when clear of the runway, contact ground" issued to a **crossing** aircraft, the
   * moment it is actually clear. The landing rollout has its own version of this inside
   * {@link resolveApproach}, which never runs for an aircraft that is only taxiing.
   */
  function resolveCrossingHandoff(ac: Internal): void {
    if (!ac.groundPending || ac.rollingOut || ac.airborne) return
    if (ac.controlledBy !== 'tower' || onRunwayNow(ac)) return
    ac.controlledBy = 'ground'
    ac.groundPending = false
    voidClearance(ac) // Tower's business with it is finished; Ground has issued it nothing
    checkIn(ac)
  }

  /**
   * Apply, or kill, a conditional line-up ("behind the landing 737, line up and wait, behind").
   *
   * The clearance was issued against a situation that had not happened yet, so this is where the
   * sim finds out whether it ever does. Three outcomes, and the two that are not "line up" are
   * the reason conditional clearances are treated carefully in the real world:
   *
   * - **The traffic stops being a landing aircraft** — it goes around, or leaves the sim. The
   *   condition can never be met by *that* aircraft, and quietly re-pointing it at the next one
   *   is how a conditional clearance kills people. It is cancelled, out loud.
   * - **The runway is not usable when the moment comes** — someone else is on it. The clearance
   *   was for a runway with one aircraft leaving it, which is not the runway this now is, so it
   *   is cancelled rather than held open for a situation nobody cleared.
   * - Otherwise the aircraft lines up on its own and says so, because the controller issued this
   *   some time ago and is not watching this one aircraft.
   */
  function resolveConditionalLineUp(ac: Internal): void {
    if (ac.lineUpBehind === null) return
    const traffic = find(ac.lineUpBehind)
    const cancel = (): void => {
      ac.lineUpBehind = null
      const rwy = runwayIdentFor(ac)
      const where = rwy ? ` runway ${rwy}` : ''
      transmit('controller', ac.controlledBy, ac, `${ac.callsign}, cancel line up and wait, hold short of${where}.`)
      transmit('pilot', ac.controlledBy, ac, `Holding short of${where}, ${ac.callsign}.`)
    }
    // Gone, or no longer landing: a go-around voids the landing clearance, which is exactly the
    // fact that makes "the landing traffic" stop being the landing traffic.
    if (!traffic || (traffic.airborne && !traffic.clearedToLand)) return cancel()
    if (traffic.airborne) return // still on final — the condition has not come true yet
    if (!hasPassed(ac, traffic)) return
    // Behind it, and it is leaving. Everything else about the runway still has to hold.
    if (!canLineUpNow(ac)) return cancel()
    enterRunway(ac)
    ac.lineUpBehind = null
    const rwy = runwayIdentFor(ac)
    transmit('pilot', ac.controlledBy, ac, `Lining up${rwy ? ` runway ${rwy}` : ''}, ${ac.callsign}.`)
  }

  /**
   * Whether `traffic` has gone past the point `ac` would enter the runway at — "behind" meaning
   * behind, not merely "has landed". Measured along the runway from the landing threshold, which
   * is the only ordering that means anything on a strip of pavement; without a runway
   * configuration there is no threshold to measure from, so it falls back to the strictest
   * reading, which is that the traffic has left the runway altogether.
   */
  function hasPassed(ac: Internal, traffic: Internal): boolean {
    // Off the runway entirely: there is nothing left to be behind, whatever the geometry says.
    // This is not a shortcut — it is the case the comparison below cannot answer. An arrival
    // that turns off *before* reaching the waiting aircraft never passes it, and a rule written
    // only as a comparison of positions would leave the clearance armed for the rest of the
    // session, waiting on something that has already finished happening.
    if (!onRunwayNow(traffic)) return true
    const entry = nearestRunwayPoint([ac.x, ac.y])
    const r = activeRunwayFor(ac)
    if (!r || !entry) return false // no threshold to measure from; wait for it to vacate
    const from = r.threshold
    return alongRunway(from, [traffic.x, traffic.y]) > alongRunway(from, entry)
  }

  /** Post-motion airborne bookkeeping: descend the final, touch down or go around at the
   *  threshold, and hand a slowed rollout over to Ground. */
  function resolveApproach(ac: Internal): void {
    if (ac.airborne) {
      const remaining = finalDistance(ac)
      if (ac.leg >= ac.path.length - 1 || remaining <= 1e-6) {
        if (ac.clearedToLand) touchdown(ac)
        else goAround(ac)
        return
      }
      ac.altitude = ac.finalAltFt * Math.min(1, remaining / (ac.finalLenNm || remaining))
      return
    }
    if (!ac.rollingOut) return
    // Vacated = past the turnoff's hold-short point (the end of the planned roll), not merely
    // outside the pavement band. Without a planned exit there is no hold-short point to pass,
    // so fall back to physically leaving the runway.
    if (!ac.vacated)
      ac.vacated = ac.exit
        ? ac.leg >= ac.path.length - 1
        : !onRunwayNow(ac) && ac.groundspeed <= TAXI_SPEED_KT + 0.01
    // The aircraft never changes frequency on its own: it moves to Ground only once Tower has
    // issued the change *and* it is actually clear of the runway.
    if (!ac.vacated || !ac.groundPending) return
    handOffToGround(ac)
    checkIn(ac)
  }

  /** A fresh set of ground services, as a departure gets on the stand. Declared rather than
   *  assigned: the seeded fleet is built during construction, before a `const` here would be
   *  initialised. */
  function servicesFor(fleetKind: string | null): { kind: string; total: number; remaining: number }[] {
    const own = fleetKind === null ? undefined : spawn?.fleets.find((f) => f.kind === fleetKind)?.servicing
    const profile = own ?? servicing
    return profile ? profile.services.map((s) => ({ kind: s.kind, total: s.sec, remaining: s.sec })) : []
  }

  /**
   * Turn an arrival round into the next departure off the same stand.
   *
   * This is what makes a stand finite. Until now an arrival vanished when it parked, so a gate
   * freed itself the moment it was reached and none of the occupancy machinery was ever under
   * real pressure; with a turnaround the aircraft sits there through its whole ground cycle,
   * and the next arrival for that gate has to wait for a real thing rather than a formality.
   *
   * The airframe is the same aircraft — type, wake, callsign and position all carry over — but
   * the flight is a new one, so it needs its own IFR clearance and its own beacon code. Returns
   * false when the field has nowhere for a departure to go, in which case it clears as before.
   */
  /** A stable index into `n` from a string, so a turnaround's departure runway is spread across
   *  the active set deterministically — no RNG draw (which would perturb the spawn stream) and the
   *  same field every replay. */
  function hashIndex(s: string, n: number): number {
    if (n <= 1) return 0
    let h = 0
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
    return ((h % n) + n) % n
  }

  function turnRound(ac: Internal): boolean {
    // A turnaround departs off a runway from the active set, not always the primary — otherwise a
    // flight that landed on 15 would depart off 08. Distributed deterministically by id so the two
    // runways share the departures the way the spawner shares fresh ones (docs/atc-multi-runway.md §5).
    const chosen = active.length ? active[hashIndex(ac.id, active.length)]!.dir : runway
    const target = chosen?.departureStart ?? runway?.departureStart ?? spawn?.departureTarget
    if (!target) return false
    ac.intent = 'departure'
    ac.goalPoint = target
    ac.dwell = -1
    ac.runwayAuth = null // the landing that earned it is over; the departure starts with none
    ac.path = [[ac.x, ac.y]]
    ac.leg = 0
    ac.targetSpeed = 0
    // Stopped on the stand, and stated now rather than a tick later: `holding` is what tells
    // the strip this is parked, and a frame reading 'taxi' on a stationary aircraft is a lie.
    ac.holding = true
    ac.groundspeed = 0
    ac.controlledBy = 'ground'
    // A new flight: the previous clearance and its beacon code do not carry over, and neither
    // does anything left from the arrival — the landing, its turnoff, or its read-back state.
    ac.squawk = null
    ac.issuedSquawk = null
    ac.edctSec = null
    ac.lastClearance = null
    ac.exit = null
    ac.assignedExitRef = null
    ac.rollingOut = false
    ac.vacated = false
    ac.groundPending = false
    ac.clearedToLand = false
    ac.held = null
    // Instructions issued to the *arrival* die with it. A give-way in particular outlives the
    // dwell whenever the named traffic is still nearby, and nothing a parked departure is then
    // told clears it — so the new flight would sit on the stand looking freshly arrived and
    // silently refuse to move, held for an instruction nobody gave it.
    ac.giveWayTo = null
    ac.services = servicesFor(ac.fleet)
    return true
  }

  /** Detect goal completion; returns ids to remove. */
  function resolveGoals(dt: number): string[] {
    const remove: string[] = []
    for (const ac of fleet) {
      if (ac.intent === 'departure') {
        // Completed once the takeoff roll reaches the far runway end — it's airborne.
        if (ac.departing && ac.leg >= ac.path.length - 1) {
          departed += 1
          remove.push(ac.id)
        }
      } else {
        const atGate =
          ac.goalPoint !== null &&
          ac.leg >= ac.path.length - 1 &&
          ac.groundspeed <= 0.5 &&
          dist([ac.x, ac.y], ac.goalPoint) < GATE_EPS
        if (atGate) {
          if (ac.dwell < 0) ac.dwell = GATE_DWELL_SEC
          else {
            ac.dwell -= dt
            if (ac.dwell <= 0) {
              arrived += 1
              // The arrival is complete either way; what differs is whether the airframe stays.
              if (!turnaround || !turnRound(ac)) remove.push(ac.id)
            }
          }
        }
      }
    }
    return remove
  }

  /** Choose a traffic class by weight. Deterministic: one draw off the seeded stream. */
  function pickFleet(rng: Rng, fleets: readonly SpawnFleet[]): SpawnFleet | undefined {
    // `Number.isFinite` rather than a bare `Math.max`: NaN would survive the `<= 0` guard
    // below, make every `roll < 0` comparison false, and pin the draw to the last fleet
    // forever. A weight that is not a number is no share at all.
    const share = (f: SpawnFleet): number => (Number.isFinite(f.weight) ? Math.max(0, f.weight) : 0)
    const total = fleets.reduce((sum, f) => sum + share(f), 0)
    if (total <= 0) return undefined
    let roll = rng.next() * total
    for (const f of fleets) {
      roll -= share(f)
      if (roll < 0) return f
    }
    return fleets[fleets.length - 1]
  }

  function trySpawn(): void {
    if (!spawn || !spawnRng) return
    if (fleet.length >= spawnCap()) return
    // The class is chosen before the stand, because what an aircraft is decides where it parks.
    // Picking a stand first and then an identity would put freighters on jet bridges in
    // proportion to how many jet bridges the field has.
    const traffic = pickFleet(spawnRng, spawn.fleets)
    if (!traffic) return
    const occupied = new Set(fleet.map((a) => a.gate).filter((g): g is string => g !== null))
    const free = traffic.gates.filter((g) => !occupied.has(g.ref))
    // A full apron simply means no spawn this attempt — this fleet's traffic backs up rather
    // than spilling onto another fleet's stands.
    if (free.length === 0) return
    const slot = free[spawnRng.int(0, free.length - 1)]
    if (!slot) return
    const intent: GroundIntent = spawnRng.next() < 0.5 ? 'departure' : 'arrival'
    // Which active runway this flight uses. A single active runway (or none) draws nothing, so the
    // single-runway spawn stream is byte-for-byte unchanged; only when a second runway is brought
    // online does the extra draw distribute traffic across the set (docs/atc-multi-runway.md §5).
    const chosen =
      active.length > 1 ? active[spawnRng.int(0, active.length - 1)]!.dir : (active[0]?.dir ?? runway)
    const { callsign, type, wake } = traffic.identity(spawnRng)
    fleet.push(
      makeInternal({
        id: `sp${seq++}`,
        callsign,
        type,
        wake,
        path:
          intent === 'departure'
            ? [slot.point]
            : chosen
              ? [finalFix(chosen, FINAL_APPROACH_NM), chosen.threshold]
              : // No active runway (a sim given only a spawn config) still establishes arrivals on
                // the configured approach — the same fallback approachNow() has always provided.
                (() => {
                  const ap = approachNow()
                  return ap ? [ap.fix, ap.threshold] : [slot.point]
                })(),
        // Arrivals cross the threshold at their own type's approach speed — a Heavy fast, a Light
        // slow — which is what makes them occupy the runway for different times: the exit model
        // brakes down from this speed to pick a turnoff (runwayExits.ts). Departures start stopped.
        targetSpeed: intent === 'departure' ? 0 : lookupAircraftType(type).approachKt,
        ...(intent === 'departure' && slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
        airborne: intent === 'arrival',
        intent,
        gate: slot.ref,
        // What it is, carried with it: the aircraft is serviced as its own class from here on,
        // including after a turnaround, when the spawner is long out of the picture.
        fleet: traffic.kind,
        goalPoint:
          intent === 'departure' ? (chosen?.departureStart ?? spawn.departureTarget) : slot.point,
      }),
    )
  }

  return {
    step(dt) {
      time += dt
      tickServices(dt)
      const caps = fleet.map((ac) =>
        ac.departing || ac.airborne
          ? Infinity // a takeoff roll and a final aren't taxi movements
          : ac.rollingOut
            ? // A landing rollout follows its own turn-speed profile — but not through another
              // aircraft. The turnoff it is braking for can have someone stopped in it (an
              // arrival awaiting a taxi clearance, most of all), and geometry alone would drive
              // straight into them. Separation is the only cap that applies: a rollout owns the
              // runway, so it yields to no reservation, no give-way and no stand.
              Math.min(rolloutCap(ac), separationCap(ac))
            : Math.min(
                separationCap(ac),
                reservationCap(ac),
                giveWayCap(ac),
                standCap(ac),
                standHoldCap(ac),
              ),
      )
      // reservationCap set each aircraft's blockedEdge; accrue continuous hold time and,
      // once it's sustained, reroute around the block if a viable parallel exists.
      for (const ac of fleet) {
        if (ac.blockedEdge) {
          ac.heldSec += dt
          maybeDivert(ac)
        } else {
          ac.heldSec = 0
        }
      }
      fleet.forEach((ac, i) => advance(ac, dt, caps[i] ?? Infinity))
      for (const ac of fleet) resolveApproach(ac)
      for (const ac of fleet) resolveCrossingHandoff(ac)
      for (const ac of fleet) resolveLineUp(ac)
      for (const ac of fleet) resolveConditionalLineUp(ac)
      for (const id of resolveGoals(dt)) {
        const i = fleet.findIndex((a) => a.id === id)
        if (i >= 0) fleet.splice(i, 1)
      }
      if (time >= nextSpawnAt) {
        nextSpawnAt = time + spawnIntervalSec()
        trySpawn()
      }
      tickAwaiting(dt)
      detectConflicts()
      incursions = detectRunwayIncursions()
    },
    snapshot(): GroundSnapshot {
      return {
        time,
        departed,
        arrived,
        comms: commsSnapshot(),
        readbackErrors,
        readbackCaught,
        slotsMet,
        slotsMissed,
        incursions,
        conflicts,
        busyHotspots: busyHotspots(fleet.map((a) => a.hotspot), hotspots),
        aircraft: fleet.map((ac) => ({
          id: ac.id,
          callsign: ac.callsign,
          type: ac.type,
          wake: ac.wake,
          x: ac.x,
          y: ac.y,
          heading: ac.heading,
          altitude: Math.round(ac.altitude),
          finalNm: finalDistance(ac),
          groundspeed: Math.round(ac.groundspeed),
          holding: ac.holding,
          holdShort: ac.holdShort,
          holdingForTakeoff: holdingForTakeoff(ac),
          status: statusOf(ac),
          controlledBy: ac.controlledBy,
          intent: ac.intent,
          gate: ac.gate,
          onRunway: onRunwayNow(ac),
          blocksTakeoff: occupiesForTakeoff(ac),
          onShortFinal: onShortFinal(ac),
          exitRef: ac.exit?.ref ?? ac.assignedExitRef,
          vacated: ac.rollingOut ? ac.vacated : false,
          // Not rollout-only: a crossing arms the same handoff, and the button that reads this
          // has to stop offering to re-issue what has already been issued.
          handoffPending: ac.groundPending,
          conflict: ac.conflict,
          converging: ac.converging,
          incursion: ac.incursion,
          hotspot: ac.hotspot,
          // Derived, never stored: "expediting" *is* "the target speed is the expedite speed".
          // Held as its own flag it went stale the moment any other clearance reset the speed —
          // crossing, lining up, rolling — and the strip claimed an expedite that had ended,
          // with no command left in the menu that would take it back.
          expedite: ac.targetSpeed === EXPEDITE_SPEED_KT,
          canHoldShort: canHoldShortNow(ac),
          canExpedite: canExpedite(ac),
          giveWayTo: ac.giveWayTo ? (find(ac.giveWayTo)?.callsign ?? null) : null,
          lineUpBehind: ac.lineUpBehind ? (find(ac.lineUpBehind)?.callsign ?? null) : null,
          waitingForStand: ac.gate !== null && standHoldCap(ac) === 0 ? ac.gate : null,
          gateBlocked:
            ac.intent === 'arrival' &&
            ac.gate !== null &&
            statusOf(ac) !== 'parked' &&
            standOccupant(ac.gate, ac) !== undefined,
          squawk: ac.squawk,
          hasInstruction: ac.lastClearance !== null,
          wakeHoldSec: wakeHoldFor(ac),
          awaitingSec: Math.floor(ac.awaitingSec),
          edctSec: ac.edctSec,
          services: ac.services.map((s) => ({ kind: s.kind, total: s.total, remaining: s.remaining })),
          serviceSec: Math.ceil(serviceRemaining(ac)),
        })),
      }
    },
    dispatch,
    runway: () => runway ?? null,
    runways: () => active.map((a) => a.dir),
    approach: () => approachNow(),
    approaches: () => {
      if (active.length) return active.map((a) => ({ fix: finalFix(a.dir, FINAL_APPROACH_NM), threshold: a.dir.threshold }))
      const ap = approachNow()
      return ap ? [ap] : []
    },
    trafficRate() {
      return trafficRate
    },
    setTrafficRate(rate: number): void {
      if (!Number.isFinite(rate) || rate < 0) {
        throw new Error(`traffic rate ${rate}: expected a finite multiplier ≥ 0`)
      }
      trafficRate = rate
      // Restart the countdown from now. Otherwise a rate change waits out the interval already
      // pending — turning traffic off would still let one more aircraft through, and turning it
      // up would take the old interval to show any effect at all.
      nextSpawnAt = time + spawnIntervalSec()
    },
    setRunway(next: ActiveRunway): DispatchResult {
      // Activate `next` on its physical runway, replacing whichever direction was active there and
      // leaving every *other* runway untouched (docs/atc-multi-runway.md §5). A single-runway field
      // has one entry, so this is the old "swap the one active direction".
      const nextId = physicalIdOf(next)
      const current = active.find((a) => a.id === nextId)
      if (current && current.dir.ident === next.ident) return refused(`RWY ${next.ident} already in use`)
      // A runway change is coordinated, not thrown. Anything committed to *this* runway — on it, on
      // short final above it, or rolling out on it — has to finish first. Deliberately stricter
      // than `blocksRunway`: that lets a departure past ROTATE_KT stop blocking, safe only because
      // everything rolls the same way; a direction change breaks exactly that assumption, so
      // anything physically on the pavement counts — a jet at 130 kt is still very much on it.
      //
      // `soleSwap` — this change turns the *only* active runway around — is when the scoping is
      // vacuous (everything active is on this one runway) and the original unscoped check applies;
      // it is also the no-guard case, where the per-runway predicates can't resolve. When a *second*
      // runway is coming online, or one of several is changing, the scoping is load-bearing:
      // traffic on the other runways must not be swept into this change.
      const soleSwap = active.length === 1 && active[0]!.id === nextId
      const committed = fleet.find((a) =>
        soleSwap
          ? blocksRunway(a) || onRunwayNow(a)
          : (onShortFinal(a) && runwaysRelated(approachRunwayOf(a), nextId, 'occupancy')) ||
            (a.rollingOut && !a.vacated && runwaysRelated(approachRunwayOf(a), nextId, 'occupancy')) ||
            (onRunwayNow(a) && runwaysRelated(physicalRunwayOf(a), nextId, 'occupancy')),
      )
      if (committed)
        return refused(
          `runway in use — ${committed.callsign} is committed to RWY ${current?.dir.ident ?? next.ident}`,
        )

      const previous = current?.dir
      active = [...active.filter((a) => a.id !== nextId), { dir: next, id: nextId }]
      runway = active[0]?.dir
      exitCache.clear() // turnoffs are derived per landing direction

      for (const ac of fleet) {
        // Only traffic using *this* runway is caught in the change; other runways carry on. When
        // this swaps the sole active runway every aircraft is on it (and targetRunwayId may be
        // unresolved without a guard), so the scoping is skipped there.
        if (!soleSwap && targetRunwayId(ac) !== nextId) continue
        // Arrivals still on final for the old direction cannot land on it any more, so they go
        // around and re-establish on the new approach. This is the cascade — one configuration
        // change hands the controller back every inbound to this runway at once.
        if (ac.airborne && ac.intent === 'arrival') {
          ac.path = [finalFix(next, FINAL_APPROACH_NM), next.threshold]
          ac.threshold = next.threshold
          ac.finalLenNm = pathLength(ac.path)
          ac.finalAltFt = glideAltitudeFt(next.glidePathDeg, ac.finalLenNm)
          goAround(ac)
          continue
        }
        // A departure that has not started rolling is now aimed at the wrong end of the field;
        // its clearance is stale and Ground has to taxi it round. Retarget the goal so the strip
        // and "taxi to the runway" mean the new end — it is not moved automatically.
        if (
          ac.intent === 'departure' &&
          !ac.departing &&
          previous &&
          ac.goalPoint &&
          dist(ac.goalPoint, previous.departureStart) < 1e-6
        ) {
          ac.goalPoint = next.departureStart
        }
      }
      return ACCEPTED
    },
    deactivateRunway(dir: ActiveRunway): DispatchResult {
      // Take a physical runway out of the active set — the counterpart to activating a second one
      // with setRunway (docs/atc-multi-runway.md §5). The last active runway cannot be closed (a
      // field always lands and departs *somewhere*). Anything physically committed to the runway —
      // on it, on short final above it, or rolling out on it — has to finish first, exactly as a
      // direction change refuses; but everything else *inbound* to it is drained onto a remaining
      // runway rather than blocking the close, which is the setRunway cascade pointed the other way.
      const id = physicalIdOf(dir)
      const entry = active.find((a) => a.id === id)
      if (!entry) return refused(`RWY ${dir.ident} is not in use`)
      if (active.length <= 1) return refused(`cannot close the only active runway`)
      const committed = fleet.find(
        (ac) =>
          targetRunwayId(ac) === id &&
          (onRunwayNow(ac) || onShortFinal(ac) || (ac.rollingOut && !ac.vacated)),
      )
      if (committed)
        return refused(`RWY ${entry.dir.ident} in use — ${committed.callsign} is committed to it`)

      const affected = fleet.filter((ac) => targetRunwayId(ac) === id)
      active = active.filter((a) => a.id !== id)
      runway = active[0]?.dir
      exitCache.clear()
      const onto = runway // a remaining runway — the traffic being drained moves here
      if (onto) {
        for (const ac of affected) {
          // Arrivals still on final for the closed runway go around and re-establish on the
          // remaining runway's approach — the same handoff a direction change gives them.
          if (ac.airborne && ac.intent === 'arrival') {
            ac.path = [finalFix(onto, FINAL_APPROACH_NM), onto.threshold]
            ac.threshold = onto.threshold
            ac.finalLenNm = pathLength(ac.path)
            ac.finalAltFt = glideAltitudeFt(onto.glidePathDeg, ac.finalLenNm)
            goAround(ac)
            continue
          }
          // A departure not yet rolling, aimed at the closed runway's end, is re-aimed at the
          // remaining one; Ground taxis it round (its goal moves, it is not moved automatically).
          // Departures only ever target a runway's `departureStart` today, so this catches them
          // all; an intersection-departure goal (a point *on* the runway, ≠ its end) would slip
          // through and need adding here — same assumption `setRunway`'s cascade above makes.
          if (
            ac.intent === 'departure' &&
            !ac.departing &&
            ac.goalPoint &&
            dist(ac.goalPoint, dir.departureStart) < 1e-6
          ) {
            ac.goalPoint = onto.departureStart
          }
        }
      }
      return ACCEPTED
    },
    exitOptions(aircraftId: string): RunwayExit[] {
      const ac = find(aircraftId)
      return ac ? exitOptionsFor(ac) : []
    },
    routeOf(aircraftId: string): Point[] {
      const ac = find(aircraftId)
      if (!ac) return []
      if (ac.leg < ac.path.length - 1) return [[ac.x, ac.y], ...ac.path.slice(ac.leg + 1)]
      if (ac.held && ac.held.length >= 2) return [[ac.x, ac.y], ...ac.held.slice(1)]
      return []
    },
    add(init: AircraftInit): string {
      fleet.push(makeInternal(init))
      return init.id
    },
    remove(aircraftId: string): boolean {
      const i = fleet.findIndex((a) => a.id === aircraftId)
      if (i < 0) return false
      fleet.splice(i, 1)
      return true
    },
    clear(): void {
      fleet.length = 0
      // Wipe the transcript with the fleet: every call in it came from an aircraft that no
      // longer exists, so leaving it makes the panel a list of ghosts. The sequence counter
      // resets too — nothing survives to collide with a low number.
      comms.length = 0
      commsSeq = 0
      commsDirty = true
    },
    standOccupied(ref: string): boolean {
      return standOccupant(ref) !== undefined
    },
    standOptions(aircraftId: string): StandOption[] {
      const ac = find(aircraftId)
      return ac ? standOptionsFor(ac) : []
    },
    pushbackOptions(aircraftId: string): PushbackOption[] {
      const ac = find(aircraftId)
      return ac ? pushbackOptionsFor(ac) : []
    },
    taxiwaysOf(aircraftId: string): string[] {
      const ac = find(aircraftId)
      return ac ? taxiwaysFor(ac) : []
    },
    inspect(aircraftId: string): AircraftDebug | null {
      const ac = find(aircraftId)
      if (!ac) return null
      return {
        id: ac.id,
        callsign: ac.callsign,
        type: ac.type,
        intent: ac.intent,
        controlledBy: ac.controlledBy,
        pos: { x: ac.x, y: ac.y, heading: ac.heading },
        targetSpeed: ac.targetSpeed,
        groundspeed: ac.groundspeed,
        goalPoint: ac.goalPoint,
        leg: ac.leg,
        path: ac.path,
        held: ac.held,
        holdShort: ac.holdShort,
        holdingForTakeoff: holdingForTakeoff(ac),
        heldRouteCrosses: heldRouteCrosses(ac),
        onRunway: onRunwayNow(ac),
        lineUpWait: ac.lineUpWait,
        rollWhenLinedUp: ac.rollWhenLinedUp,
        departing: ac.departing,
        rollingOut: ac.rollingOut,
        runwayAuth: ac.runwayAuth,
      }
    },
  }
}
