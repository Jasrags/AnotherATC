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
    }
  }

  const fleet: Internal[] = inits.map(makeInternal)
  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  function statusOf(ac: Internal): GroundStatus {
    if (ac.holdShort) return 'holdShort'
    if (ac.dwell >= 0) return 'parked'
    const cleared = ac.groundspeed > 0.5 || (ac.targetSpeed > 0 && ac.leg < ac.path.length - 1)
    if (cleared) return 'taxi'
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
      // Follow leaders (same direction); at crossings give way to the right only.
      const sameDir = angleDelta(ac.heading, o.heading) < SAME_DIR_DEG
      if (!sameDir && cross >= 0) continue // traffic on the left — ac has right of way
      const gap = forward - MIN_GAP_NM
      const c = gap <= 0 ? 0 : (gap / (LOOK_AHEAD_NM - MIN_GAP_NM)) * TAXI_SPEED_KT
      if (c < cap) cap = c
    }
    return cap
  }

  function detectConflicts(): void {
    for (const ac of fleet) ac.conflict = false
    for (let i = 0; i < fleet.length; i += 1) {
      for (let j = i + 1; j < fleet.length; j += 1) {
        const a = fleet[i]
        const b = fleet[j]
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < CONFLICT_NM) {
          a.conflict = true
          b.conflict = true
        }
      }
    }
  }

  function advance(ac: Internal, dt: number, cap: number): void {
    const atEnd = ac.leg >= ac.path.length - 1
    const target = Math.min(atEnd ? 0 : ac.targetSpeed, cap)

    if (ac.groundspeed < target) {
      ac.groundspeed = Math.min(target, ac.groundspeed + TAXI_ACCEL * dt)
    } else if (ac.groundspeed > target) {
      ac.groundspeed = Math.max(target, ac.groundspeed - TAXI_ACCEL * dt)
    }

    const stopped = ac.groundspeed <= 0.01 && target === 0
    ac.holding = stopped
    ac.holdShort = stopped && atEnd && ac.held !== null
    if (stopped) {
      ac.groundspeed = 0
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

  function routeTo(ac: Internal, dest: Point, appendExact: boolean): void {
    if (!graph) return
    const startKey = graph.nearestNode([ac.x, ac.y])
    const goalKey = graph.nearestNode(dest)
    if (!startKey || !goalKey) return
    const routePoints = graph.route(startKey, goalKey)
    if (routePoints.length === 0) return
    const full: Point[] = [[ac.x, ac.y], ...routePoints]
    if (appendExact) full.push(dest)
    const { path, held } = plan(full)
    ac.path = path
    ac.leg = 0
    ac.held = held
    ac.dwell = -1
    ac.targetSpeed = TAXI_SPEED_KT
    ac.holding = false
    ac.holdShort = false
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
      case 'hold':
        ac.targetSpeed = 0
        break
      case 'resume':
        if (ac.leg < ac.path.length - 1) {
          ac.targetSpeed = TAXI_SPEED_KT
          ac.holding = false
        }
        break
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
    }
  }

  /** Detect goal completion; returns ids to remove. */
  function resolveGoals(dt: number): string[] {
    const remove: string[] = []
    for (const ac of fleet) {
      if (ac.intent === 'departure') {
        if (ac.goalPoint !== null && guard && onRunway([ac.x, ac.y], guard)) {
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
      const caps = fleet.map((ac) => separationCap(ac))
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
  }
}
