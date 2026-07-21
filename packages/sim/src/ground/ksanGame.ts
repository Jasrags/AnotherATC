import { KSAN_SURFACE } from '../world/ksan'
import { createRng, type Rng } from '../random'
import type { Point } from '../world/types'
import type { AircraftInit, GateSlot, ServicingConfig, SpawnConfig } from './sim'
import type { NamedDestination, WakeCategory } from './types'

/** Pre-push ground services, run in parallel (game seconds). Fueling is the long pole, so it
 *  sets when pushback unlocks; the shorter services finish earlier. Tuned for surface pacing. */
const SERVICING: ServicingConfig = {
  services: [
    { kind: 'fuel', sec: 45 },
    { kind: 'cargo', sec: 34 },
    { kind: 'catering', sec: 28 },
    { kind: 'water', sec: 20 },
    { kind: 'cabin', sec: 13 },
  ],
}

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

/** Passenger terminal gates from OSM gate nodes (Terminal 2 = 20–51, Terminal 1 = 101–119),
 *  where an aircraft parks at the gate. Cargo/remote stands are excluded from spawning. */
function gates(): GateSlot[] {
  const slots: GateSlot[] = []
  const seen = new Set<string>()
  for (const f of KSAN_SURFACE.features) {
    if (f.kind !== 'gate' || !f.ref || seen.has(f.ref)) continue
    const p = f.points[0]
    if (!p) continue
    seen.add(f.ref)
    slots.push({ ref: f.ref, point: p })
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

/** Length (nm) of the straight-in final arrivals are established on. */
const FINAL_NM = 4

/**
 * The KSAN ground game: a few aircraft to start, plus a spawn config that feeds
 * departures (at gates, heading to RWY 27) and arrivals (off RWY 9, heading to a
 * gate). Deterministic for a given seed.
 */
export function buildKsanGroundGame(seed = 1): {
  inits: AircraftInit[]
  spawn: SpawnConfig
  destinations: NamedDestination[]
  servicing: ServicingConfig
} {
  const slots = gates()
  const { west, east } = runwayEnds()
  const departureTarget = east // RWY 27 threshold
  // Arrivals land on RWY 9 (west threshold), so the final lies west of the field along the
  // runway centerline extended: the west threshold pushed FINAL_NM further away from the east.
  const runLen = Math.hypot(west[0] - east[0], west[1] - east[1]) || 1
  const finalFix: Point = [
    west[0] + ((west[0] - east[0]) / runLen) * FINAL_NM,
    west[1] + ((west[1] - east[1]) / runLen) * FINAL_NM,
  ]

  const destinations: NamedDestination[] = [
    { id: 'rwy27', label: 'RWY 27', kind: 'runway', point: east },
    { id: 'rwy09', label: 'RWY 9', kind: 'runway', point: west },
  ]

  const spawn: SpawnConfig = {
    gates: slots,
    departureTarget,
    approach: { fix: finalFix, threshold: west },
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

  return { inits, spawn, destinations, servicing: SERVICING }
}
