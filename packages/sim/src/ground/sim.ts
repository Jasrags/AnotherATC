import { createRng, type Rng } from '../random'
import type { Point } from '../world/types'
import type {
  ControllerPosition,
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
import {
  COMMS_LOG_LIMIT,
  misheardSquawk,
  negative,
  phraseFor,
  type PhraseContext,
  type Transmission,
  type TransmissionFrom,
} from './comms'
import { wakeSeparationSec, WAKE_TIME_SCALE } from './wake'
import { onRunway, splitRouteAtRunway, type RunwayGuard } from './runwayGuard'
import {
  finalFix,
  glideAltitudeFt,
  landingEnd,
  reciprocalIdent,
  takeoffEnd,
  FINAL_APPROACH_NM,
  type ActiveRunway,
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
}

/** A gate/stand the spawner can use. */
export interface GateSlot {
  ref: string
  point: Point
}

/** Final-approach geometry: arrivals appear airborne at `fix` (on the runway centerline
 *  extended) and fly the straight final in to `threshold` (the landing threshold). */
export interface ApproachConfig {
  fix: Point
  threshold: Point
}

/** Deterministic traffic generation. */
export interface SpawnConfig {
  gates: readonly GateSlot[]
  /** Where departures head to leave the surface (a runway point). */
  departureTarget: Point
  /** Where arrivals appear: established on final, inbound to the landing threshold. */
  approach: ApproachConfig
  intervalSec: number
  maxAircraft: number
  seed: number
  /** Produces a callsign/type for each spawned aircraft. */
  identity: (rng: Rng, intent: GroundIntent) => { callsign: string; type: string; wake: WakeCategory }
}

/** One parallel ground service and how long it takes (game seconds). */
export interface ServiceSpec {
  kind: string
  sec: number
}

/** Ground-servicing model: the parallel services a parked departure must complete before it
 *  may push back (fueling is usually the long pole). Omit to disable servicing entirely. */
export interface ServicingConfig {
  services: readonly ServiceSpec[]
}

export interface GroundSimOptions {
  graph?: TaxiGraph
  guard?: RunwayGuard
  spawn?: SpawnConfig
  servicing?: ServicingConfig
  /** Published controller frequencies, quoted in handoff phraseology ("contact tower 118.3").
   *  Omit and the transcript simply says "contact tower". */
  frequencies?: { ground: string; tower: string }
  /** Read-back errors: with what probability a pilot mishears a clearance, and the seed that
   *  makes it reproducible. Omit (the default) and every read-back is correct — which is why
   *  every test written before this mechanic still holds. */
  readback?: { errorRate: number; seed: number }
  /** The runway direction in use. Supplies the real landing threshold (which is *not* the end
   *  of the pavement where the threshold is displaced) and the far end a takeoff rolls toward,
   *  instead of guessing both from the polyline endpoints. */
  runway?: ActiveRunway
}

const TAXI_ACCEL = 4
const TAXI_SPEED_KT = 15
/** Pushback creep speed (kt) — a tug easing the aircraft off the stand. */
const PUSHBACK_SPEED_KT = 5
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
/** Inside this distance (nm) from the threshold, an arrival on final owns the runway:
 *  no takeoff clearance and no line-up may be issued underneath it. Exported so the UI can
 *  gate the same clearances the sim would refuse — but they read the `onShortFinal` flag off
 *  the snapshot rather than re-deriving this comparison from a rounded display distance. */
const SHORT_FINAL_NM = 1.5
/** How often (s) a rolled-out arrival retries routing off the runway when routing fails. */
const EXIT_RETRY_SEC = 1
/** How far (nm ≈ 180 ft) up the runway a lining-up aircraft rolls past the point it entered, so
 *  it finishes pointing down the runway rather than across it. */
const LINEUP_ALIGN_NM = 0.03
/** How close (nm ≈ 24 ft) a node must be to the centerline to count as *on* it. The runway
 *  guard's band is deliberately wider than the pavement, so "on the runway" also catches
 *  connector nodes a hundred feet off the centerline — fine for occupancy, useless for
 *  choosing where to line up. */
const CENTERLINE_EPS_NM = 0.004
/** How close (nm) counts as reaching a gate. */
const GATE_EPS = 0.02
/** Seconds an arrival dwells at the gate before it clears the stand. */
const GATE_DWELL_SEC = 8

// ─── Separation ─────────────────────────────────────────────────────────────
/** How far ahead (nm) an aircraft watches for traffic. */
const LOOK_AHEAD_NM = 0.06
/** Half-width (nm) of the path corridor: traffic outside it is off to the side. */
const CORRIDOR_HALF_NM = 0.012
/** Minimum gap (nm) an aircraft keeps behind traffic ahead. */
const MIN_GAP_NM = 0.022
/** Two aircraft closer than this (nm) are in conflict. */
const CONFLICT_NM = 0.015
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
    | 'finalNm'
    | 'exitRef'
    | 'vacated'
    | 'handoffPending'
    // Derived at snapshot time from `lastClearance`, not stored twice.
    | 'hasInstruction'
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
  /** Seconds until the next Tower→Ground exit-routing attempt (see {@link EXIT_RETRY_SEC}). */
  exitRetrySec: number
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
  /** Undirected edge (key) the reservation is currently making this aircraft hold short of, or null. */
  blockedEdge: string | null
  /** Seconds spent continuously reservation-held — once past a threshold, we try to divert. */
  heldSec: number
  /** Contested edges a diversion has already routed this aircraft around (kept off reroutes). */
  avoidEdges: Set<string>
  /** Blocked edges we already tried and failed to divert around (skip recompute until recleared). */
  divertTried: Set<string>
  /** The last clearance transmitted to this aircraft — what "say again" repeats. */
  lastClearance: GroundCommand | null
  /** What the controller actually said, when the pilot read it back wrong. Null when the last
   *  read-back was correct (which is indistinguishable from the outside — deliberately). */
  misheard: { squawk: string } | null
}

/**
 * A deterministic surface-movement simulation with intent-driven traffic:
 * departures taxi to the runway and leave; arrivals taxi to a gate and clear.
 * A {@link SpawnConfig} feeds new traffic over time. Internal state is mutated
 * in place each tick; {@link GroundSim.snapshot} hands out fresh immutable objects.
 */
export function createGroundSim(inits: readonly AircraftInit[], opts: GroundSimOptions = {}): GroundSim {
  const { graph, guard, spawn, servicing, frequencies, readback } = opts
  /** The runway direction in use. Mutable: an airport changes configuration. */
  let runway: ActiveRunway | undefined = opts.runway
  /** Where arrivals are established, derived from the active runway when there is one. */
  const approachNow = (): ApproachConfig | null =>
    runway
      ? { fix: finalFix(runway, FINAL_APPROACH_NM), threshold: runway.threshold }
      : (spawn?.approach ?? null)
  let time = 0
  let departed = 0
  let arrived = 0
  /** The most recent departure to begin its takeoff roll — the wake-separation leader. */
  let lastDeparture: { wake: WakeCategory; atTime: number } | null = null
  let seq = 0
  const spawnRng = spawn ? createRng(spawn.seed) : null
  let nextSpawnAt = spawn ? spawn.intervalSec : Infinity

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
  function transmit(from: TransmissionFrom, position: ControllerPosition, ac: Internal, text: string): void {
    commsSeq += 1
    comms.push({ seq: commsSeq, time, from, position, aircraftId: ac.id, callsign: ac.callsign, text })
    if (comms.length > COMMS_LOG_LIMIT) comms.splice(0, comms.length - COMMS_LOG_LIMIT)
    commsView = [...comms]
  }

  /** Runway designator as spoken: no leading zero ("09" → "9"). */
  const runwayIdent = (): string | null => runway?.ident.replace(/^0/, '') ?? null

  function phraseContext(ac: Internal): PhraseContext {
    const rwy = runwayIdent()
    return {
      callsign: ac.callsign,
      runway: rwy,
      squawk: ac.squawk,
      taxiways: taxiwaysFor(ac),
      destination:
        ac.intent === 'departure' ? (rwy ? `runway ${rwy}` : null) : ac.gate ? `gate ${ac.gate}` : null,
      giveWayTo: ac.giveWayTo ? (find(ac.giveWayTo)?.callsign ?? null) : null,
      exitRef: ac.exit?.ref ?? ac.assignedExitRef,
      towerFreq: frequencies?.tower ?? null,
      groundFreq: frequencies?.ground ?? null,
      vacated: ac.rollingOut ? ac.vacated : true,
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

  /** Corrupt what the pilot heard, saving the correct value for a later correction. Returns
   *  whether anything was misheard. Only clearances carrying a discrete value can be misheard;
   *  everything else is read back verbatim. */
  function maybeMishear(cmd: GroundCommand, ac: Internal): boolean {
    if (!readbackRng || !readback || cmd.type !== 'clearance' || !ac.squawk) return false
    if (readbackRng.next() >= readback.errorRate) return false
    const wrong = misheardSquawk(ac.squawk, readbackRng.next())
    if (wrong === ac.squawk) return false
    ac.misheard = { squawk: ac.squawk }
    ac.squawk = wrong
    readbackErrors += 1
    return true
  }

  /** Undo a misheard clearance: the aircraft acts on what the controller actually said. */
  function correctMishearing(ac: Internal): boolean {
    if (!ac.misheard) return false
    ac.squawk = ac.misheard.squawk
    ac.misheard = null
    readbackCaught += 1
    return true
  }

  /** Log the exchange for a command that was just applied. `position` is who *issued* it —
   *  captured before the command ran, since a handoff changes the owner mid-command. */
  function logExchange(cmd: GroundCommand, ac: Internal, position: ControllerPosition): void {
    // The instruction is phrased from the state as issued; the read-back from the state as the
    // pilot heard it. When nothing is misheard the two are the same context.
    const ex = phraseFor(cmd, phraseContext(ac))
    if (!ex) return
    ac.lastClearance = cmd
    const readbackText = maybeMishear(cmd, ac) ? (phraseFor(cmd, phraseContext(ac))?.readback ?? ex.readback) : ex.readback
    transmit('controller', position, ac, ex.instruction)
    transmit('pilot', position, ac, readbackText)
  }

  /** "Negative, …": repeat the last clearance, correctly. Never mishears — the point of a
   *  correction is that it lands. */
  function logCorrection(ac: Internal, position: ControllerPosition): void {
    const prior = ac.lastClearance
    if (!prior) return
    const ex = phraseFor(prior, phraseContext(ac))
    if (!ex) return
    transmit('controller', position, ac, negative(ex.instruction))
    transmit('pilot', position, ac, ex.readback)
  }

  /** The pilot's first call on a new frequency, right after a handoff. */
  function checkIn(ac: Internal): void {
    const rwy = runwayIdent()
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
    // The descent is the runway's *published* glide path, not one hard-coded angle: KSAN is
    // 3.3° to 09 and a notably steep 3.5° to 27 (docs/SAN/runway-9-27.md).
    const finalAltFt = glideAltitudeFt(runway?.glidePathDeg ?? DEFAULT_GLIDE_DEG, finalLenNm)
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
      airborne,
      clearedToLand: false,
      rollingOut: false,
      threshold,
      finalLenNm,
      finalAltFt,
      exitRetrySec: 0,
      exit: null,
      assignedExitRef: null,
      brakeRate: ROLLOUT_DECEL,
      speedLimits: [],
      vacated: false,
      groundPending: false,
      services:
        servicing && (init.intent ?? 'departure') === 'departure'
          ? servicing.services.map((s) => ({ kind: s.kind, total: s.sec, remaining: s.sec }))
          : [],
      blockedEdge: null,
      heldSec: 0,
      avoidEdges: new Set(),
      divertTried: new Set(),
      lastClearance: null,
      misheard: null,
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
    // With a configuration there is one answer: everyone is using the same direction, so the
    // far end is the same for a takeoff roll and for a landing rollout.
    if (runway) return runway.farEnd
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
    // the last ~1,100 ft is physically there but is not landing distance available.
    const far =
      runway && dist(threshold, runway.threshold) < 1e-6 ? landingEnd(runway) : farRunwayEnd(threshold)
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
  function exitOptionsFor(ac: Internal): RunwayExit[] {
    if (ac.intent !== 'arrival' || !ac.threshold || ac.vacated) return []
    const at = ac.airborne ? 0 : alongRunway(ac.threshold, [ac.x, ac.y])
    const speed = ac.airborne ? ac.targetSpeed : ac.groundspeed
    return exitsForLanding(ac.threshold).filter((e) => {
      const remaining = e.distanceNm - at
      return remaining > 0 && brakeRateFor(speed, e.speedKt, remaining) <= MAX_BRAKE_KT_S
    })
  }

  const fleet: Internal[] = inits.map(makeInternal)
  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  function statusOf(ac: Internal): GroundStatus {
    if (ac.airborne) return ac.clearedToLand ? 'landing' : 'onFinal'
    if (ac.rollingOut) return 'rollout'
    if (ac.departing) return 'departing'
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
   *  while anyone occupies its surface or is committed on short final above it. */
  function blocksRunway(ac: Internal): boolean {
    return occupiesForTakeoff(ac) || onShortFinal(ac)
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
  function lineUpPath(ac: Internal, lineup: Point): Point[] {
    const pts: Point[] = [[ac.x, ac.y]]
    if (graph && guard) {
      const startKey = graph.nearestNode([ac.x, ac.y])
      // Route to a node genuinely *on the centerline* — the runway polyline's own vertices —
      // so the path runs through the connector's geometry, which is where its curvature is
      // recorded, and finishes on the stripe rather than at the pavement edge.
      const entryKey = graph.nearestNodeWhere(lineup, (n) => {
        const c = nearestRunwayPoint(n)
        return c !== null && dist(n, c) < CENTERLINE_EPS_NM
      })
      const route = startKey && entryKey ? graph.route(startKey, entryKey) : []
      for (const p of route) {
        const last = pts[pts.length - 1]!
        if (dist(last, p) > 1e-6) pts.push(p)
      }
    }
    // Finish on the centerline. Projecting the *end of the route* rather than the aircraft's
    // original position keeps this ahead of it: projecting from where it was holding would
    // double back to a point already behind, swinging it through a near-reversal.
    const arrived = pts[pts.length - 1]!
    const base = nearestRunwayPoint(arrived) ?? lineup
    if (dist(arrived, base) > 1e-6) pts.push(base)
    // …then roll far enough up the runway to be aligned with the takeoff direction.
    const far = farRunwayEnd(base)
    if (far) {
      const d = dist(base, far)
      if (d > 1e-6) {
        const step = Math.min(LINEUP_ALIGN_NM, d / 2)
        pts.push([base[0] + ((far[0] - base[0]) / d) * step, base[1] + ((far[1] - base[1]) / d) * step])
      }
    }
    return pts
  }

  /**
   * Runway (nm) left ahead of an aircraft in the takeoff direction. Negative when it is past the
   * far end — i.e. lined up facing the wrong way for the runway in use.
   */
  function takeoffRunRemaining(ac: Internal): number {
    const far = runway ? takeoffEnd(runway) : farRunwayEnd([ac.x, ac.y])
    if (!far) return Infinity
    // Without a configuration `farRunwayEnd` answers "whichever end is further away", so this
    // measures toward that end by construction and effectively never trips — the legacy path
    // never had the wrong-end bug this guards against.
    const from = runway?.departureStart ?? null
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
    if (runway) {
      const here: Point = [ac.x, ac.y]
      const atFarEnd = dist(here, runway.farEnd) < dist(here, runway.departureStart)
      if (atFarEnd)
        return `RWY ${reciprocalIdent(runway.ident)} is not in use — RWY ${runway.ident} is the active runway`
    }
    return 'insufficient runway remaining for takeoff'
  }

  /** Seconds of wake separation still owed before this holding-short departure may roll. */
  function wakeHoldFor(ac: Internal): number {
    if (ac.intent !== 'departure' || !(ac.holdShort || ac.lineUpWait) || !lastDeparture) return 0
    const required = wakeSeparationSec(lastDeparture.wake, ac.wake) * WAKE_TIME_SCALE
    return Math.max(0, Math.ceil(required - (time - lastDeparture.atTime)))
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
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = graph.nearestNode(dest)
    if (!startKey || !goalKey) return
    const avoid = new Set(ac.avoidEdges)
    avoid.add(blocked)
    const alt = graph.routeAvoiding(startKey, goalKey, avoid)
    if (alt.length === 0) {
      ac.divertTried.add(blocked)
      return
    }
    const direct = graph.route(startKey, goalKey)
    if (direct.length > 0 && pathLength(alt) > DIVERSION_COST_FACTOR * pathLength(direct)) {
      ac.divertTried.add(blocked)
      return
    }
    // Preserve an exact appended goal (e.g. a stand point that isn't a graph node).
    const goalPt = graph.nodePoint(goalKey)
    const appendExact = !goalPt || dist(goalPt, dest) > 1e-6
    ac.avoidEdges = avoid
    applyRoute(ac, alt, dest, appendExact)
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
      return Infinity
    }
    const dx = o.x - ac.x
    const dy = o.y - ac.y
    const rad = (ac.heading * Math.PI) / 180
    const forward = dx * Math.sin(rad) + dy * Math.cos(rad)
    const d = Math.hypot(dx, dy)
    if (forward < -GIVEWAY_CLEARED_NM || d > GIVEWAY_FORGET_NM) {
      ac.giveWayTo = null // traffic has passed behind us, or is well clear — done giving way
      return Infinity
    }
    return d <= GIVEWAY_WATCH_NM ? 0 : Infinity // hold only once it's actually near
  }

  function detectConflicts(): void {
    for (const ac of fleet) ac.conflict = false
    for (let i = 0; i < fleet.length; i += 1) {
      for (let j = i + 1; j < fleet.length; j += 1) {
        const a = fleet[i]
        const b = fleet[j]
        // Neither a takeoff roll nor an aircraft on final is a surface (taxi) conflict.
        if (a?.departing || b?.departing || a?.airborne || b?.airborne) continue
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < CONFLICT_NM) {
          a.conflict = true
          b.conflict = true
        }
      }
    }
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
      if (ac.pushingBack && atEnd) ac.pushingBack = false // finished pushing onto the taxilane
      return
    }

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
    ac.pushingBack = false // …and aborts an in-progress pushback,
    ac.lineUpWait = false // …a line-up on the runway,
    ac.departing = false // …and a takeoff roll — a taxi clearance means it's taxiing now.
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
    ac.holdShort = false
    ac.heldSec = 0
    ac.blockedEdge = null
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

  /** Route to a destination. Returns false (nothing applied) when there is no graph or
   *  no path reaches the destination, so the caller can report the refusal. */
  function routeTo(ac: Internal, dest: Point, appendExact: boolean): boolean {
    if (!graph) return false
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = goalNodeFor(dest, [ac.x, ac.y])
    if (!startKey || !goalKey) return false
    const route = graph.route(startKey, goalKey)
    if (route.length === 0) return false
    clearDiversion(ac)
    applyRoute(ac, route, dest, appendExact)
    return true
  }

  /** Route via an ordered taxiway sequence, falling back to shortest path if that
   *  exact sequence can't reach the destination (so a bad clearance still taxis).
   *  Returns false when no route could be applied at all. */
  function routeVia(ac: Internal, taxiways: readonly string[], dest: Point, appendExact: boolean): boolean {
    if (!graph) return false
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = goalNodeFor(dest, [ac.x, ac.y])
    if (!startKey || !goalKey) return false
    const via = graph.routeVia(startKey, goalKey, taxiways)
    const route = via.length > 0 ? via : graph.route(startKey, goalKey)
    if (route.length === 0) return false
    clearDiversion(ac)
    applyRoute(ac, route, dest, appendExact)
    return true
  }

  const ACCEPTED: DispatchResult = { ok: true }
  const refused = (reason: string): DispatchResult => ({ ok: false, reason })

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
  ])

  /**
   * Apply a command, then — only if it was accepted — put it on the air. Logging here rather
   * than at each `return ACCEPTED` means a new command cannot be added without a transcript,
   * and a refused one can never appear as though it had been transmitted.
   */
  function dispatch(command: GroundCommand): DispatchResult {
    const ac = find(command.aircraftId)
    const issuedBy = ac?.controlledBy ?? 'ground'
    const result = applyCommand(command)
    if (result.ok && ac) {
      if (command.type === 'sayAgain') {
        logCorrection(ac, issuedBy)
        return result
      }
      logExchange(command, ac, issuedBy)
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
        return routeTo(ac, ac.goalPoint, true) ? ACCEPTED : refused('no taxi route to the goal')
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
        const alleyKey = graph.nearestNode([ac.x, ac.y])
        const alley = alleyKey ? graph.nodePoint(alleyKey) : undefined
        if (!alley || dist([ac.x, ac.y], alley) < GATE_EPS) return refused('no alley to push onto')
        clearDiversion(ac)
        ac.path = [[ac.x, ac.y], alley]
        ac.leg = 0
        ac.held = null
        ac.dwell = -1
        ac.pushingBack = true
        ac.targetSpeed = PUSHBACK_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        return ACCEPTED
      }
      case 'hold':
        ac.targetSpeed = 0
        return ACCEPTED
      case 'resume':
        ac.giveWayTo = null // "continue taxi" also cancels a give-way hold
        if (ac.leg < ac.path.length - 1) {
          ac.targetSpeed = TAXI_SPEED_KT
          ac.holding = false
        }
        return ACCEPTED
      case 'giveWay': {
        const target = find(command.toId)
        if (!target || target === ac) return refused('unknown or self give-way target')
        ac.giveWayTo = command.toId
        return ACCEPTED
      }
      case 'crossRunway':
        if (!ac.held || ac.held.length < 2) return refused('not holding short of a runway')
        // Don't clear onto an occupied runway.
        if (guard && fleet.some((o) => o !== ac && blocksRunway(o))) return refused('runway occupied')
        clearDiversion(ac)
        ac.path = ac.held
        ac.leg = 0
        ac.held = null
        ac.targetSpeed = TAXI_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        return ACCEPTED
      case 'sayAgain':
        // Refused only when there is nothing to repeat — never because the read-back happened
        // to be correct, which would turn the mechanic into a free answer.
        if (!ac.lastClearance) return refused('nothing has been issued to that aircraft')
        correctMishearing(ac)
        return ACCEPTED
      case 'clearance':
        // Clearance delivery: issue the IFR clearance to a departure, assigning a beacon
        // code. Gates pushback — a gate departure can't push until it's been cleared.
        if (ac.intent !== 'departure') return refused('only departures receive IFR clearance')
        if (ac.squawk) return refused('already cleared')
        ac.squawk = nextSquawk()
        return ACCEPTED
      case 'contactTower': {
        // Ground → Tower handoff: transfer a departure holding short of its own runway to
        // Local Control (Tower). A frequency change only — it stays holding short, and Tower
        // then issues line-up-and-wait / takeoff clearance. No runway or wake gate here; those
        // gate the takeoff clearance itself (see docs/atc-tower.md).
        if (ac.intent !== 'departure') return refused('only departures contact tower for takeoff')
        if (ac.controlledBy === 'tower') return refused('already on tower frequency')
        if (!ac.holdShort) return refused('not holding short of the runway')
        // A departure merely holding short to *cross* the runway (its route continues past it,
        // so it has no goal on it) is not a takeoff — the controller clears it across instead.
        if (guard && (!ac.goalPoint || !onRunway(ac.goalPoint, guard)))
          return refused('route crosses the runway — clear it to cross, not for takeoff')
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
        // A departure actually ROLLING down the runway (moving away) does NOT block a line-up
        // behind it — that's precisely what "line up and wait" is for (anticipated separation).
        // But one merely *cleared and not yet moving* (departing, still at its spot), any
        // stationary occupant, or an aircraft crossing, still blocks it: #2 must not taxi onto
        // an occupied spot. (Line-up uses the "rolling" bar; takeoff clearance uses the stricter
        // "rotated" bar — see clearedForTakeoff.)
        if (
          guard &&
          fleet.some(
            (o) =>
              o !== ac &&
              (onShortFinal(o) ||
                (onRunwayNow(o) && !(o.departing && o.groundspeed > ROLLING_KT))),
          )
        )
          return refused('runway occupied')
        // Line up onto the runway centerline in front of the aircraft (nearest point), not at
        // its far departure-runway goal — so it lines up where it's holding, at either end.
        const lineup: Point = nearestRunwayPoint([ac.x, ac.y]) ?? ac.goalPoint ?? [ac.x, ac.y]
        clearDiversion(ac)
        ac.path = lineUpPath(ac, lineup)
        ac.leg = 0
        ac.held = null
        ac.holdShort = false
        ac.lineUpWait = true
        ac.targetSpeed = TAXI_SPEED_KT
        ac.holding = false
        return ACCEPTED
      }
      case 'clearedForTakeoff': {
        // Tower: release a departure for the takeoff roll — directly from holding short (the
        // fast path) or from line-up-and-wait. It accelerates to the far runway end and lifts
        // off (despawns as a completed departure). Requires a clear runway and satisfied wake
        // interval; those gates live here now, not at the handoff.
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency — hand off to tower first')
        if (ac.intent !== 'departure') return refused('only departures are cleared for takeoff')
        if (!ac.holdShort && !ac.lineUpWait) return refused('not holding short or lined up')
        if (guard && (!ac.goalPoint || !onRunway(ac.goalPoint, guard)))
          return refused('route crosses the runway — clear it to cross, not for takeoff')
        // Enough runway ahead to actually get airborne. This is what stops an aircraft at the
        // wrong end being launched into a few hundred feet of pavement and then the grass.
        const blocked = takeoffBlocked(ac)
        if (blocked) return refused(blocked)
        // The runway must be clear of blocking traffic — but a preceding departure that has
        // rotated (near liftoff) no longer blocks, so the next may be cleared behind it.
        if (guard && fleet.some((o) => o !== ac && blocksRunway(o))) return refused('runway occupied')
        // Wake-turbulence hold: a following departure can't roll until the interval behind
        // the previous departure has elapsed (see docs/wake-turbulence.md).
        if (lastDeparture) {
          const required = wakeSeparationSec(lastDeparture.wake, ac.wake) * WAKE_TIME_SCALE
          const remaining = required - (time - lastDeparture.atTime)
          if (remaining > 0) {
            const category = lastDeparture.wake === 'J' ? 'Super' : 'Heavy'
            return refused(`wake turbulence — ${Math.ceil(remaining)}s behind ${category}`)
          }
        }
        // The roll ends where the declared takeoff run does, which on RWY 09 is 1,121 ft short
        // of the pavement — that distance is not available in that direction.
        const far = runway ? takeoffEnd(runway) : farRunwayEnd([ac.x, ac.y])
        if (!far) return refused('no runway end found')
        clearDiversion(ac)
        ac.path = [[ac.x, ac.y], far]
        ac.leg = 0
        ac.held = null
        ac.lineUpWait = false
        ac.departing = true
        ac.targetSpeed = TAKEOFF_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        lastDeparture = { wake: ac.wake, atTime: time }
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
        // Tower → Ground. Issued during the rollout it is the real-world "when vacated,
        // contact ground": it arms the change, which takes effect the moment the aircraft is
        // actually clear. A pilot never switches frequency unprompted, so nothing else does.
        if (ac.intent !== 'arrival') return refused('only arrivals are handed to ground after landing')
        if (ac.controlledBy !== 'tower') return refused('not on tower frequency')
        if (ac.airborne) return refused('still airborne')
        if (!ac.rollingOut) return refused('not on the landing roll')
        if (ac.groundPending) return refused('already sent to ground')
        // Arm the change only if it isn't applicable yet; a failed immediate handoff must not
        // leave the aircraft looking "already sent" when it was actually refused.
        if (ac.vacated) return handOffToGround(ac) ? ACCEPTED : refused('no taxi route to the gate')
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
        if (guard && fleet.some((o) => o !== ac && blocksRunway(o))) return refused('runway occupied')
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
  function planRollout(ac: Internal): void {
    const options = exitOptionsFor(ac)
    const assigned = options.find((e) => e.ref === ac.assignedExitRef)
    const preferred = chooseExit(options, ac.groundspeed, alongRunway(ac.threshold ?? [ac.x, ac.y], [ac.x, ac.y]))
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
  function goAround(ac: Internal): void {
    const fix = ac.path[0]
    if (!fix) return
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
    // A go-around is the pilot's call, not the controller's — it is announced, not cleared.
    transmit('pilot', 'tower', ac, `${ac.callsign}, going around.`)
  }

  /**
   * Tower → Ground handoff: once the rollout has slowed to taxi speed the arrival can leave
   * the runway, so it becomes an ordinary Ground aircraft routed to its gate. `goalPoint` is
   * guaranteed for an airborne init (validated in {@link makeInternal}). Routing can still fail
   * — no graph, or a gate the graph can't reach — so the attempt is retried, but at
   * {@link EXIT_RETRY_SEC} rather than every tick: a failing route is a full Dijkstra search,
   * and the aircraft is parked on the runway while it fails.
   */
  function handOffToGround(ac: Internal): boolean {
    if (!ac.goalPoint || !routeTo(ac, ac.goalPoint, true)) return false
    ac.rollingOut = false
    ac.groundPending = false
    ac.controlledBy = 'ground'
    return true
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

  /** Post-motion airborne bookkeeping: descend the final, touch down or go around at the
   *  threshold, and hand a slowed rollout over to Ground. */
  function resolveApproach(ac: Internal, dt: number): void {
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
    ac.exitRetrySec -= dt
    if (ac.exitRetrySec > 0) return
    ac.exitRetrySec = EXIT_RETRY_SEC
    if (handOffToGround(ac)) checkIn(ac)
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
              remove.push(ac.id)
            }
          }
        }
      }
    }
    return remove
  }

  function trySpawn(): void {
    if (!spawn || !spawnRng) return
    if (fleet.length >= spawn.maxAircraft) return
    const occupied = new Set(fleet.map((a) => a.gate).filter((g): g is string => g !== null))
    const free = spawn.gates.filter((g) => !occupied.has(g.ref))
    if (free.length === 0) return
    const slot = free[spawnRng.int(0, free.length - 1)]
    if (!slot) return
    const intent: GroundIntent = spawnRng.next() < 0.5 ? 'departure' : 'arrival'
    const { callsign, type, wake } = spawn.identity(spawnRng, intent)
    fleet.push(
      makeInternal({
        id: `sp${seq++}`,
        callsign,
        type,
        wake,
        path:
          intent === 'departure'
            ? [slot.point]
            : (() => {
                const ap = approachNow()
                return ap ? [ap.fix, ap.threshold] : [slot.point]
              })(),
        targetSpeed: intent === 'departure' ? 0 : APPROACH_SPEED_KT,
        airborne: intent === 'arrival',
        intent,
        gate: slot.ref,
        goalPoint:
          intent === 'departure' ? (runway?.departureStart ?? spawn.departureTarget) : slot.point,
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
            ? rolloutCap(ac) // …and a landing rollout follows its own turn-speed profile
            : Math.min(separationCap(ac), reservationCap(ac), giveWayCap(ac)),
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
      for (const ac of fleet) resolveApproach(ac, dt)
      for (const id of resolveGoals(dt)) {
        const i = fleet.findIndex((a) => a.id === id)
        if (i >= 0) fleet.splice(i, 1)
      }
      if (time >= nextSpawnAt) {
        nextSpawnAt = time + (spawn?.intervalSec ?? Infinity)
        trySpawn()
      }
      detectConflicts()
    },
    snapshot(): GroundSnapshot {
      return {
        time,
        departed,
        arrived,
        comms: commsView,
        readbackErrors,
        readbackCaught,
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
          handoffPending: ac.rollingOut && ac.groundPending,
          conflict: ac.conflict,
          giveWayTo: ac.giveWayTo ? (find(ac.giveWayTo)?.callsign ?? null) : null,
          squawk: ac.squawk,
          hasInstruction: ac.lastClearance !== null,
          wakeHoldSec: wakeHoldFor(ac),
          services: ac.services.map((s) => ({ kind: s.kind, total: s.total, remaining: s.remaining })),
          serviceSec: Math.ceil(serviceRemaining(ac)),
        })),
      }
    },
    dispatch,
    runway: () => runway ?? null,
    approach: () => approachNow(),
    setRunway(next: ActiveRunway): DispatchResult {
      // A runway change is coordinated, not thrown. Anything already committed to the runway —
      // on it, or on short final above it — has to finish first; the controller stops the flow,
      // lets it land or go, and then turns the airport around.
      if (runway && next.ident === runway.ident) return refused(`RWY ${next.ident} already in use`)
      // Deliberately stricter than `blocksRunway`: that predicate lets a departure past
      // ROTATE_KT stop blocking, which is safe only because everything rolls the *same* way.
      // A direction change breaks exactly that assumption, so anything physically on the
      // pavement counts — a jet at 130 kt is still very much on the runway.
      const committed = fleet.find((a) => blocksRunway(a) || onRunwayNow(a))
      if (committed)
        return refused(`runway in use — ${committed.callsign} is committed to RWY ${runway?.ident ?? ''}`.trim())

      const previous = runway
      runway = next
      exitCache.clear() // turnoffs are derived per landing direction

      for (const ac of fleet) {
        // Arrivals still on final for the old direction cannot land on it any more, so they go
        // around and re-establish on the new approach. This is the cascade — one configuration
        // change hands the controller back every inbound at once.
        if (ac.airborne && ac.intent === 'arrival') {
          const ap = approachNow()
          if (ap) {
            ac.path = [ap.fix, ap.threshold]
            ac.threshold = ap.threshold
            ac.finalLenNm = pathLength(ac.path)
            ac.finalAltFt = glideAltitudeFt(next.glidePathDeg, ac.finalLenNm)
          }
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
    },
    taxiwaysOf(aircraftId: string): string[] {
      const ac = find(aircraftId)
      return ac ? taxiwaysFor(ac) : []
    },
  }
}
