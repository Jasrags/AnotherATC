import type { Point } from '../world/types'
import type {
  GroundAircraft,
  GroundCommand,
  GroundSim,
  GroundSnapshot,
  GroundStatus,
  WakeCategory,
} from './types'
import type { TaxiGraph } from './taxiGraph'
import { splitRouteAtRunway, type RunwayGuard } from './runwayGuard'

/** Initial definition of one aircraft: a route (nm waypoints) taxied at a target speed. */
export interface AircraftInit {
  id: string
  callsign: string
  type: string
  wake: WakeCategory
  /** Ordered waypoints in local nm. A single point = parked/stationary. */
  path: readonly Point[]
  /** Target taxi speed in knots. */
  targetSpeed: number
  /** Optional fixed heading (used when the aircraft is parked). */
  heading?: number
}

/** Taxi acceleration/deceleration in knots per second. */
const TAXI_ACCEL = 4
/** Default speed assigned when a controller issues a taxi clearance. */
const TAXI_SPEED_KT = 15

function bearing(ax: number, ay: number, bx: number, by: number): number {
  return (Math.atan2(bx - ax, by - ay) * 180) / Math.PI
}

function normalizeDeg(d: number): number {
  return ((d % 360) + 360) % 360
}

// `status` is derived at snapshot time (see statusOf), so it is not stored here.
interface Internal extends Omit<GroundAircraft, 'status'> {
  path: readonly Point[]
  leg: number
  targetSpeed: number
  /** Route beyond a hold-short line, released by a crossRunway clearance. */
  held: Point[] | null
}

/**
 * A deterministic surface-movement simulation. Aircraft follow their route at a
 * performance-limited speed and stop at runway hold-short lines until cleared to
 * cross. A {@link TaxiGraph} enables `taxiTo` routing; a {@link RunwayGuard}
 * enables hold-short behaviour. Internal state is mutated in place each tick;
 * {@link GroundSim.snapshot} hands consumers fresh immutable objects.
 */
export function createGroundSim(
  inits: readonly AircraftInit[],
  graph?: TaxiGraph,
  runwayGuard?: RunwayGuard,
): GroundSim {
  let time = 0

  // Split a full route at the first runway crossing (if a guard is present).
  const plan = (route: readonly Point[]): { path: Point[]; held: Point[] | null } => {
    if (!runwayGuard || route.length < 2) return { path: [...route], held: null }
    const { drive, held } = splitRouteAtRunway(route, runwayGuard)
    return { path: drive, held }
  }

  const fleet: Internal[] = inits.map((init) => {
    const { path, held } = plan(init.path)
    const start = path[0] ?? ([0, 0] as Point)
    const next = path[1]
    const heading =
      init.heading ?? (next ? bearing(start[0], start[1], next[0], next[1]) : 0)
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
      path,
      leg: 0,
      targetSpeed: init.targetSpeed,
      held,
    }
  })

  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  function statusOf(ac: Internal): GroundStatus {
    if (ac.holdShort) return 'holdShort'
    const cleared = ac.groundspeed > 0.5 || (ac.targetSpeed > 0 && ac.leg < ac.path.length - 1)
    if (cleared) return 'taxi'
    if (ac.path.length < 2 && ac.held === null) return 'parked'
    return 'holding'
  }

  function advance(ac: Internal, dt: number): void {
    const atEnd = ac.leg >= ac.path.length - 1
    const target = atEnd ? 0 : ac.targetSpeed

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

    let remaining = (ac.groundspeed * dt) / 3600 // knots·s → nm
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

  function dispatch(command: GroundCommand): void {
    const ac = find(command.aircraftId)
    if (!ac) return
    switch (command.type) {
      case 'taxiTo': {
        if (!graph) return
        const startKey = graph.nearestNode([ac.x, ac.y])
        const goalKey = graph.nearestNode(command.dest)
        if (!startKey || !goalKey) return
        const routePoints = graph.route(startKey, goalKey)
        if (routePoints.length === 0) return
        const { path, held } = plan([[ac.x, ac.y], ...routePoints])
        ac.path = path
        ac.leg = 0
        ac.held = held
        ac.targetSpeed = TAXI_SPEED_KT
        ac.holding = false
        ac.holdShort = false
        break
      }
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
        // Only meaningful when holding short; release the route across the runway.
        if (ac.held && ac.held.length >= 2) {
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

  function routeOf(aircraftId: string): Point[] {
    const ac = find(aircraftId)
    if (!ac) return []
    if (ac.leg < ac.path.length - 1) return [[ac.x, ac.y], ...ac.path.slice(ac.leg + 1)]
    if (ac.held && ac.held.length >= 2) return [[ac.x, ac.y], ...ac.held.slice(1)]
    return []
  }

  return {
    step(dt) {
      time += dt
      for (const ac of fleet) advance(ac, dt)
    },
    snapshot(): GroundSnapshot {
      return {
        time,
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
        })),
      }
    },
    dispatch,
    routeOf,
  }
}
