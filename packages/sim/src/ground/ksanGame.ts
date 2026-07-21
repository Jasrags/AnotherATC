import { KSAN_SURFACE } from '../world/ksan'
import { createRng, type Rng } from '../random'
import type { Point } from '../world/types'
import type { AircraftInit, GateSlot, ServicingConfig, SpawnConfig } from './sim'
import type { NamedDestination, WakeCategory } from './types'
import { finalFix, type ActiveRunway, type RunwayLayout } from './runway'

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

/** Length (nm) of the straight-in final arrivals are established on. */
const FINAL_NM = 4

/**
 * Runway 09/27, from the FAA survey rather than from the pavement polyline — see
 * docs/SAN/runway-9-27.md. Both ends are displaced, and 27's displacement is 1,810 ft, so the
 * landing threshold is nowhere near the end of the runway.
 *
 * Local nm from the airport reference point (x = east, y = north).
 */
const RWY = {
  westEnd: [-0.7397, 0.2113] as Point, // physical pavement end, RWY 09 departure start
  eastEnd: [0.7434, -0.2159] as Point, // physical pavement end, RWY 27 departure start
  thr09: [-0.5819, 0.1659] as Point, // RWY 09 landing threshold — displaced 1,000 ft
  thr27: [0.4578, -0.1336] as Point, // RWY 27 landing threshold — displaced 1,810 ft
}

/**
 * The two runway configurations. KSAN is single-runway, so exactly one is active and **both
 * arrivals and departures use it** — you cannot land one way and depart the other.
 *
 * 27 is the normal configuration (the sea breeze is westerly); 09 is used mainly for early
 * morning departures. Glide path angles and pattern directions are the published ones.
 */
export const KSAN_RUNWAYS: Record<'09' | '27', ActiveRunway> = {
  '27': {
    ident: '27',
    threshold: RWY.thr27,
    departureStart: RWY.eastEnd,
    farEnd: RWY.westEnd,
    toraFt: 9401, // the whole runway, including the pavement before the displaced threshold
    ldaFt: 7591,
    glidePathDeg: 3.5, // steep — LOC only, no ILS to 27
    pattern: 'right', // noise abatement: right turn out over the bay
  },
  '09': {
    ident: '09',
    threshold: RWY.thr09,
    departureStart: RWY.westEnd,
    farEnd: RWY.eastEnd,
    // 09 declares less than the pavement offers in both cases — 1,121 ft at the east end is
    // not available in this direction, so LDA is 1,100 ft short of threshold→pavement end.
    toraFt: 8280,
    ldaFt: 7280,
    glidePathDeg: 3.3,
    pattern: 'left',
  },
}

/**
 * Runway 09/27 as painted. The EMAS bed is at the **west** end — the FAA remark reads
 * "EMAS 315 FT IN LENGTH BY 218 FT IN WIDTH LCTD AT DER 27", and the departure end of runway 27
 * is the west end. It arrests aircraft overrunning westward, i.e. landing or rejecting on 27.
 */
export const KSAN_RUNWAY_LAYOUT: RunwayLayout = {
  ident: '09/27',
  widthFt: 200,
  ends: [
    { ident: '09', pavementEnd: RWY.westEnd, threshold: RWY.thr09, emas: { lengthFt: 315, widthFt: 218 } },
    { ident: '27', pavementEnd: RWY.eastEnd, threshold: RWY.thr27, emas: null },
  ],
}

/**
 * The KSAN ground game: a few aircraft to start, plus a spawn config that feeds departures
 * (from gates to the active runway) and arrivals (established on the final for that same
 * runway). Deterministic for a given seed.
 */
export function buildKsanGroundGame(
  seed = 1,
  config: '09' | '27' = '27',
): {
  inits: AircraftInit[]
  spawn: SpawnConfig
  destinations: NamedDestination[]
  servicing: ServicingConfig
  runway: ActiveRunway
} {
  const slots = gates()
  const runway = KSAN_RUNWAYS[config]
  // Departures roll from the pavement end behind the threshold — the displaced portion is
  // theirs to use, it is only landings that may not touch down on it.
  const departureTarget = runway.departureStart

  const destinations: NamedDestination[] = [
    { id: 'rwy27', label: 'RWY 27', kind: 'runway', point: KSAN_RUNWAYS['27'].departureStart },
    { id: 'rwy09', label: 'RWY 9', kind: 'runway', point: KSAN_RUNWAYS['09'].departureStart },
  ]

  const spawn: SpawnConfig = {
    gates: slots,
    departureTarget,
    approach: { fix: finalFix(runway, FINAL_NM), threshold: runway.threshold },
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

  return { inits, spawn, destinations, servicing: SERVICING, runway }
}
