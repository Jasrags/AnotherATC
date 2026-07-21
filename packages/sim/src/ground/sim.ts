import { createRng, type Rng } from '../random'
import type { Point } from '../world/types'
import type {
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
import { wakeSeparationSec, WAKE_TIME_SCALE } from './wake'
import { onRunway, splitRouteAtRunway, type RunwayGuard } from './runwayGuard'

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
}

const TAXI_ACCEL = 4
const TAXI_SPEED_KT = 15
/** Pushback creep speed (kt) — a tug easing the aircraft off the stand. */
const PUSHBACK_SPEED_KT = 5
/** Takeoff roll: full-power acceleration (kt/s) up to the liftoff speed (kt). */
const TAKEOFF_ACCEL = 12
const TAKEOFF_SPEED_KT = 140
/** Groundspeed (kt) at which a departure has "rotated" — effectively airborne, so it no longer
 *  blocks the next departure's takeoff clearance (anticipated separation).
 *  SAFETY NOTE: clearing #2 once #1 passes this speed is collision-free only because takeoff
 *  acceleration is uniform across all aircraft (TAKEOFF_ACCEL) — #2 is then a pure time-shifted
 *  replay of #1, so the gap can only grow. If per-type/wake-category acceleration is ever added,
 *  a slower-accelerating leader followed by a faster follower could close the gap; revisit this
 *  gate (add a distance floor) then, since detectConflicts() excludes departing pairs. */
const ROTATE_KT = 120

// ─── Final approach & landing (Tower) ────────────────────────────────────────
/** Height (ft) at the final fix. With FINAL_NM below this is a ~3° geometric descent. */
const FINAL_ALT_FT = 1250
/** Approach speed (kt) flown down the final, and the speed at touchdown. */
const APPROACH_SPEED_KT = 140
/** Braking deceleration (kt/s) on the landing rollout — harder than a taxi ramp. */
const ROLLOUT_DECEL = 6
/** Inside this distance (nm) from the threshold, an arrival on final owns the runway:
 *  no takeoff clearance and no line-up may be issued underneath it. Exported so the UI can
 *  gate the same clearances the sim would refuse — but they read the `onShortFinal` flag off
 *  the snapshot rather than re-deriving this comparison from a rounded display distance. */
const SHORT_FINAL_NM = 1.5
/** How often (s) a rolled-out arrival retries routing off the runway when routing fails. */
const EXIT_RETRY_SEC = 1
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
  /** Seconds until the next Tower→Ground exit-routing attempt (see {@link EXIT_RETRY_SEC}). */
  exitRetrySec: number
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
}

/**
 * A deterministic surface-movement simulation with intent-driven traffic:
 * departures taxi to the runway and leave; arrivals taxi to a gate and clear.
 * A {@link SpawnConfig} feeds new traffic over time. Internal state is mutated
 * in place each tick; {@link GroundSim.snapshot} hands out fresh immutable objects.
 */
export function createGroundSim(inits: readonly AircraftInit[], opts: GroundSimOptions = {}): GroundSim {
  const { graph, guard, spawn, servicing } = opts
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
    return {
      id: init.id,
      callsign: init.callsign,
      type: init.type,
      wake: init.wake,
      x: start[0],
      y: start[1],
      heading: normalizeDeg(heading),
      altitude: airborne ? FINAL_ALT_FT : 0,
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
      finalLenNm: threshold ? pathLength(path) : 0,
      exitRetrySec: 0,
      services:
        servicing && (init.intent ?? 'departure') === 'departure'
          ? servicing.services.map((s) => ({ kind: s.kind, total: s.sec, remaining: s.sec }))
          : [],
      blockedEdge: null,
      heldSec: 0,
      avoidEdges: new Set(),
      divertTried: new Set(),
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
    const accel = ac.departing ? TAKEOFF_ACCEL : ac.rollingOut ? ROLLOUT_DECEL : TAXI_ACCEL

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

  function dispatch(command: GroundCommand): DispatchResult {
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
        ac.path = [[ac.x, ac.y], lineup]
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
        const far = farRunwayEnd([ac.x, ac.y])
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
    const far = farRunwayEnd([ac.x, ac.y])
    ac.airborne = false
    ac.altitude = 0
    ac.rollingOut = true
    ac.threshold = null
    ac.path = far ? [[ac.x, ac.y], far] : [[ac.x, ac.y]]
    ac.leg = 0
    ac.held = null
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
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
    ac.altitude = FINAL_ALT_FT
    ac.groundspeed = ac.targetSpeed
    ac.clearedToLand = false
    const next = ac.path[1]
    if (next) ac.heading = normalizeDeg(bearing(fix[0], fix[1], next[0], next[1]))
  }

  /**
   * Tower → Ground handoff: once the rollout has slowed to taxi speed the arrival can leave
   * the runway, so it becomes an ordinary Ground aircraft routed to its gate. `goalPoint` is
   * guaranteed for an airborne init (validated in {@link makeInternal}). Routing can still fail
   * — no graph, or a gate the graph can't reach — so the attempt is retried, but at
   * {@link EXIT_RETRY_SEC} rather than every tick: a failing route is a full Dijkstra search,
   * and the aircraft is parked on the runway while it fails.
   */
  function exitRunway(ac: Internal, dt: number): void {
    ac.exitRetrySec -= dt
    if (ac.exitRetrySec > 0) return
    ac.exitRetrySec = EXIT_RETRY_SEC
    if (!ac.goalPoint || !routeTo(ac, ac.goalPoint, true)) return
    ac.rollingOut = false
    ac.controlledBy = 'ground'
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
      ac.altitude = FINAL_ALT_FT * Math.min(1, remaining / (ac.finalLenNm || remaining))
      return
    }
    if (ac.rollingOut && ac.groundspeed <= TAXI_SPEED_KT + 0.01) exitRunway(ac, dt)
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
            : [spawn.approach.fix, spawn.approach.threshold],
        targetSpeed: intent === 'departure' ? 0 : APPROACH_SPEED_KT,
        airborne: intent === 'arrival',
        intent,
        gate: slot.ref,
        goalPoint: intent === 'departure' ? spawn.departureTarget : slot.point,
      }),
    )
  }

  return {
    step(dt) {
      time += dt
      tickServices(dt)
      const caps = fleet.map((ac) =>
        ac.departing || ac.airborne || ac.rollingOut
          ? Infinity // a takeoff roll, a final, and a landing rollout aren't taxi movements
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
          conflict: ac.conflict,
          giveWayTo: ac.giveWayTo ? (find(ac.giveWayTo)?.callsign ?? null) : null,
          squawk: ac.squawk,
          wakeHoldSec: wakeHoldFor(ac),
          services: ac.services.map((s) => ({ kind: s.kind, total: s.total, remaining: s.remaining })),
          serviceSec: Math.ceil(serviceRemaining(ac)),
        })),
      }
    },
    dispatch,
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
      if (!ac || !graph) return []
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
    },
  }
}
