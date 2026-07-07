import type { Point } from '../world/types'
import type { GroundAircraft, GroundCommand, GroundSim, GroundSnapshot, WakeCategory } from './types'
import type { TaxiGraph } from './taxiGraph'

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

interface Internal extends GroundAircraft {
  path: readonly Point[]
  leg: number
  targetSpeed: number
}

/**
 * A deterministic surface-movement simulation. Aircraft follow their route at a
 * performance-limited speed; heading tracks the current segment. A {@link TaxiGraph}
 * (optional) enables `taxiTo` routing. Internal state is mutated in place each tick;
 * {@link GroundSim.snapshot} hands consumers fresh immutable objects.
 */
export function createGroundSim(inits: readonly AircraftInit[], graph?: TaxiGraph): GroundSim {
  let time = 0

  const fleet: Internal[] = inits.map((init) => {
    const start = init.path[0] ?? ([0, 0] as Point)
    const next = init.path[1]
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
      holding: init.path.length < 2,
      path: init.path,
      leg: 0,
      targetSpeed: init.targetSpeed,
    }
  })

  const find = (id: string): Internal | undefined => fleet.find((a) => a.id === id)

  function advance(ac: Internal, dt: number): void {
    const atEnd = ac.leg >= ac.path.length - 1
    const target = atEnd ? 0 : ac.targetSpeed

    if (ac.groundspeed < target) {
      ac.groundspeed = Math.min(target, ac.groundspeed + TAXI_ACCEL * dt)
    } else if (ac.groundspeed > target) {
      ac.groundspeed = Math.max(target, ac.groundspeed - TAXI_ACCEL * dt)
    }

    ac.holding = target === 0 && ac.groundspeed <= 0.01
    if (ac.groundspeed <= 0.01 && target === 0) {
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
        // Prepend the exact current position so it drives smoothly onto the graph.
        ac.path = [[ac.x, ac.y], ...routePoints]
        ac.leg = 0
        ac.targetSpeed = TAXI_SPEED_KT
        ac.holding = false
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
    }
  }

  function routeOf(aircraftId: string): Point[] {
    const ac = find(aircraftId)
    if (!ac || ac.leg >= ac.path.length - 1) return []
    const ahead = ac.path.slice(ac.leg + 1)
    return [[ac.x, ac.y], ...ahead]
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
        })),
      }
    },
    dispatch,
    routeOf,
  }
}
