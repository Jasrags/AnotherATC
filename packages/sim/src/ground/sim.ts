import { createRng, type Rng } from '../random'
import type { Point } from '../world/types'
import type {
  GroundAircraft,
  GroundCommand,
  GroundIntent,
  GroundSim,
  GroundSnapshot,
  GroundStatus,
  WakeCategory,
} from './types'
import type { TaxiGraph } from './taxiGraph'
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

/** Deterministic traffic generation. */
export interface SpawnConfig {
  gates: readonly GateSlot[]
  /** Where departures head to leave the surface (a runway point). */
  departureTarget: Point
  /** Where arrivals appear (a runway exit). */
  arrivalSpawn: Point
  intervalSec: number
  maxAircraft: number
  seed: number
  /** Produces a callsign/type for each spawned aircraft. */
  identity: (rng: Rng, intent: GroundIntent) => { callsign: string; type: string; wake: WakeCategory }
}

export interface GroundSimOptions {
  graph?: TaxiGraph
  guard?: RunwayGuard
  spawn?: SpawnConfig
}

const TAXI_ACCEL = 4
const TAXI_SPEED_KT = 15
/** Pushback creep speed (kt) — a tug easing the aircraft off the stand. */
const PUSHBACK_SPEED_KT = 5
/** Takeoff roll: full-power acceleration (kt/s) up to the liftoff speed (kt). */
const TAKEOFF_ACCEL = 12
const TAKEOFF_SPEED_KT = 140
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
interface Internal extends Omit<GroundAircraft, 'status'> {
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
  /** Rolling for takeoff down the runway toward the far end (after contacting tower). */
  departing: boolean
}

/**
 * A deterministic surface-movement simulation with intent-driven traffic:
 * departures taxi to the runway and leave; arrivals taxi to a gate and clear.
 * A {@link SpawnConfig} feeds new traffic over time. Internal state is mutated
 * in place each tick; {@link GroundSim.snapshot} hands out fresh immutable objects.
 */
export function createGroundSim(inits: readonly AircraftInit[], opts: GroundSimOptions = {}): GroundSim {
  const { graph, guard, spawn } = opts
  let time = 0
  let departed = 0
  let arrived = 0
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
    const { path, held } = plan(init.path)
    const start = path[0] ?? ([0, 0] as Point)
    const next = path[1]
    const heading = init.heading ?? (next ? bearing(start[0], start[1], next[0], next[1]) : 0)
    return {
      id: init.id,
      callsign: init.callsign,
      type: init.type,
      wake: init.wake,
      x: start[0],
      y: start[1],
      heading: normalizeDeg(heading),
      groundspeed: 0,
      holding: path.length < 2,
      holdShort: path.length < 2 && held !== null,
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

  const fleet: Internal[] = inits.map(makeInternal)
  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  function statusOf(ac: Internal): GroundStatus {
    if (ac.departing) return 'departing'
    if (ac.pushingBack) return 'pushback'
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

  /** Speed cap (kt) for one aircraft from traffic ahead in its corridor. */
  function separationCap(ac: Internal): number {
    if (ac.targetSpeed <= 0 && ac.groundspeed <= 0) return Infinity
    const rad = (ac.heading * Math.PI) / 180
    const hx = Math.sin(rad)
    const hy = Math.cos(rad)
    let cap = Infinity
    for (const o of fleet) {
      if (o === ac) continue
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
    const d = ctx.distToNext - HOLD_MARGIN_NM
    return d <= 0 ? 0 : Math.min(TAXI_SPEED_KT, (d / HOLD_RAMP_NM) * TAXI_SPEED_KT)
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
        if (a?.departing || b?.departing) continue // a takeoff roll isn't a taxi conflict
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < CONFLICT_NM) {
          a.conflict = true
          b.conflict = true
        }
      }
    }
  }

  function advance(ac: Internal, dt: number, cap: number): void {
    const atEnd = ac.leg >= ac.path.length - 1
    // A takeoff roll accelerates hard and does not slow at the end — it lifts off.
    const target = ac.departing ? ac.targetSpeed : Math.min(atEnd ? 0 : ac.targetSpeed, cap)
    const accel = ac.departing ? TAKEOFF_ACCEL : TAXI_ACCEL

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
    ac.pushingBack = false // …and aborts an in-progress pushback
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
    ac.holdShort = false
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

  function routeTo(ac: Internal, dest: Point, appendExact: boolean): void {
    if (!graph) return
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = goalNodeFor(dest, [ac.x, ac.y])
    if (!startKey || !goalKey) return
    applyRoute(ac, graph.route(startKey, goalKey), dest, appendExact)
  }

  /** Route via an ordered taxiway sequence, falling back to shortest path if that
   *  exact sequence can't reach the destination (so a bad clearance still taxis). */
  function routeVia(ac: Internal, taxiways: readonly string[], dest: Point, appendExact: boolean): void {
    if (!graph) return
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = goalNodeFor(dest, [ac.x, ac.y])
    if (!startKey || !goalKey) return
    const via = graph.routeVia(startKey, goalKey, taxiways)
    applyRoute(ac, via.length > 0 ? via : graph.route(startKey, goalKey), dest, appendExact)
  }

  function dispatch(command: GroundCommand): void {
    const ac = find(command.aircraftId)
    if (!ac) return
    switch (command.type) {
      case 'taxiTo':
        routeTo(ac, command.dest, command.exact ?? false)
        break
      case 'taxiToGoal':
        // Append the exact goal so departures hold short at the runway and
        // arrivals park at the stand (rather than stopping at the nearest node).
        if (ac.goalPoint) routeTo(ac, ac.goalPoint, true)
        break
      case 'taxiVia':
        routeVia(ac, command.taxiways, command.dest, command.exact ?? false)
        break
      case 'taxiViaGoal':
        if (ac.goalPoint) routeVia(ac, command.taxiways, ac.goalPoint, true)
        break
      case 'pushback': {
        // Ease the aircraft off the stand onto the nearest taxilane node (the alley),
        // then it's ready to taxi. Departures only, only from a stationary aircraft that
        // is still at its gate (a single-point route) — ignored once routed or moving.
        if (!graph || ac.intent !== 'departure' || ac.pushingBack || ac.groundspeed > 0.1 || ac.path.length > 1)
          break
        const alleyKey = graph.nearestNode([ac.x, ac.y])
        const alley = alleyKey ? graph.nodePoint(alleyKey) : undefined
        if (!alley || dist([ac.x, ac.y], alley) < GATE_EPS) break
        ac.path = [[ac.x, ac.y], alley]
        ac.leg = 0
        ac.held = null
        ac.dwell = -1
        ac.pushingBack = true
        ac.targetSpeed = PUSHBACK_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        break
      }
      case 'hold':
        ac.targetSpeed = 0
        break
      case 'resume':
        ac.giveWayTo = null // "continue taxi" also cancels a give-way hold
        if (ac.leg < ac.path.length - 1) {
          ac.targetSpeed = TAXI_SPEED_KT
          ac.holding = false
        }
        break
      case 'giveWay': {
        const target = find(command.toId)
        if (target && target !== ac) ac.giveWayTo = command.toId
        break
      }
      case 'crossRunway':
        if (ac.held && ac.held.length >= 2) {
          // Don't clear onto an occupied runway.
          if (guard && fleet.some((o) => o !== ac && onRunway([o.x, o.y], guard))) break
          ac.path = ac.held
          ac.leg = 0
          ac.held = null
          ac.targetSpeed = TAXI_SPEED_KT
          ac.holding = false
          ac.holdShort = false
        }
        break
      case 'clearance':
        // Clearance delivery: issue the IFR clearance to a departure, assigning a beacon
        // code. Gates pushback — a gate departure can't push until it's been cleared.
        if (ac.intent === 'departure' && !ac.squawk) ac.squawk = nextSquawk()
        break
      case 'contactTower': {
        // Ground → Tower handoff: a departure holding short of its runway lines up and
        // rolls for takeoff down the runway toward the far end, then lifts off (despawns
        // as a completed departure). Requires a clear runway.
        if (ac.intent !== 'departure' || !ac.holdShort) break
        if (guard && fleet.some((o) => o !== ac && onRunway([o.x, o.y], guard))) break
        const far = farRunwayEnd([ac.x, ac.y])
        if (!far) break
        ac.path = [[ac.x, ac.y], far]
        ac.leg = 0
        ac.held = null
        ac.departing = true
        ac.targetSpeed = TAKEOFF_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        break
      }
    }
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
        path: [intent === 'departure' ? slot.point : spawn.arrivalSpawn],
        targetSpeed: 0,
        intent,
        gate: slot.ref,
        goalPoint: intent === 'departure' ? spawn.departureTarget : slot.point,
      }),
    )
  }

  return {
    step(dt) {
      time += dt
      const caps = fleet.map((ac) =>
        ac.departing ? Infinity : Math.min(separationCap(ac), reservationCap(ac), giveWayCap(ac)),
      )
      fleet.forEach((ac, i) => advance(ac, dt, caps[i] ?? Infinity))
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
          groundspeed: Math.round(ac.groundspeed),
          holding: ac.holding,
          holdShort: ac.holdShort,
          status: statusOf(ac),
          intent: ac.intent,
          gate: ac.gate,
          conflict: ac.conflict,
          giveWayTo: ac.giveWayTo ? (find(ac.giveWayTo)?.callsign ?? null) : null,
          squawk: ac.squawk,
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
