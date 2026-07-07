import { KSAN_SURFACE } from '../world/ksan'
import { createRng, type Rng } from '../random'
import type { Point, SurfaceFeature } from '../world/types'
import type { AircraftInit, GateSlot, SpawnConfig } from './sim'
import type { NamedDestination, WakeCategory } from './types'

const AIRLINES = ['AAL', 'UAL', 'DAL', 'SWA', 'ASA', 'NKS', 'JBU', 'SKW']
const TYPES: readonly [string, WakeCategory][] = [
  ['B738', 'M'],
  ['A320', 'M'],
  ['A321', 'M'],
  ['B739', 'M'],
  ['A20N', 'M'],
  ['E75L', 'M'],
  ['CRJ7', 'M'],
  ['B763', 'H'],
]

function identity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const airline = AIRLINES[rng.int(0, AIRLINES.length - 1)] ?? 'AAL'
  const [type, wake] = TYPES[rng.int(0, TYPES.length - 1)] ?? ['B738', 'M']
  return { callsign: `${airline}${rng.int(100, 1899)}`, type, wake }
}

function minSqDistToTaxi(p: Point, taxi: readonly Point[]): number {
  let m = Infinity
  for (const q of taxi) {
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
    if (d < m) m = d
  }
  return m
}

/** A stand's stop position: the endpoint farthest from the taxiway (deepest into the ramp),
 *  i.e. where an aircraft actually parks — not a mid-line vertex. */
function standStop(f: SurfaceFeature, taxi: readonly Point[]): Point {
  const a = f.points[0]
  const b = f.points[f.points.length - 1]
  if (!a) return [0, 0]
  if (!b) return a
  return minSqDistToTaxi(a, taxi) >= minSqDistToTaxi(b, taxi) ? a : b
}

/** Gates from parking positions, parked at their stop position, de-duplicated by ref. */
function gates(): GateSlot[] {
  const taxi: Point[] = []
  for (const f of KSAN_SURFACE.features) {
    if (f.kind === 'taxiway' || f.kind === 'taxilane') for (const p of f.points) if (p) taxi.push(p)
  }
  const slots: GateSlot[] = []
  const seen = new Set<string>()
  let n = 0
  for (const f of KSAN_SURFACE.features) {
    if (f.kind !== 'parking_position' || f.points.length < 1) continue
    const ref = f.ref ?? `G${n}`
    if (seen.has(ref)) continue
    seen.add(ref)
    slots.push({ ref, point: standStop(f, taxi) })
    n += 1
  }
  return slots
}

/** The runway's two threshold points (min-x = RWY 9 / west, max-x = RWY 27 / east). */
function runwayEnds(): { west: Point; east: Point } {
  let west: Point | null = null
  let east: Point | null = null
  for (const f of KSAN_SURFACE.features) {
    if (f.kind !== 'runway') continue
    for (const p of f.points) {
      if (!p) continue
      if (!west || p[0] < west[0]) west = p
      if (!east || p[0] > east[0]) east = p
    }
  }
  return { west: west ?? [0, 0], east: east ?? [0, 0] }
}

/** Nearest taxiway vertex to a point — where arrivals join the surface. */
function nearestTaxiwayVertex(target: Point): Point {
  let best: Point | null = null
  let bestD = Infinity
  for (const f of KSAN_SURFACE.features) {
    if (f.kind !== 'taxiway' && f.kind !== 'taxilane') continue
    for (const p of f.points) {
      if (!p) continue
      const d = (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
  }
  return best ?? target
}

/**
 * The KSAN ground game: a few aircraft to start, plus a spawn config that feeds
 * departures (at gates, heading to RWY 27) and arrivals (off RWY 9, heading to a
 * gate). Deterministic for a given seed.
 */
export function buildKsanGroundGame(seed = 1): {
  inits: AircraftInit[]
  spawn: SpawnConfig
  destinations: NamedDestination[]
} {
  const slots = gates()
  const { west, east } = runwayEnds()
  const departureTarget = east // RWY 27 threshold
  const arrivalSpawn = nearestTaxiwayVertex(west) // rolled out at the RWY 9 end

  const destinations: NamedDestination[] = [
    { id: 'rwy27', label: 'RWY 27', kind: 'runway', point: east },
    { id: 'rwy09', label: 'RWY 9', kind: 'runway', point: west },
  ]

  const spawn: SpawnConfig = {
    gates: slots,
    departureTarget,
    arrivalSpawn,
    intervalSec: 22,
    maxAircraft: 12,
    seed,
    identity: (rng: Rng) => identity(rng),
  }

  // Seed a handful so the surface isn't empty at t=0.
  const inits: AircraftInit[] = []
  const seedGates = slots.slice(0, 3)
  seedGates.forEach((slot, i) => {
    // deterministic initial identities
    const { callsign, type, wake } = identity(createRng(seed + i + 1))
    inits.push({
      id: `init${i}`,
      callsign,
      type,
      wake,
      path: [slot.point],
      targetSpeed: 0,
      intent: 'departure',
      gate: slot.ref,
      goalPoint: departureTarget,
    })
  })

  return { inits, spawn, destinations }
}
