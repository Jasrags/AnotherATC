import { KSAN_SURFACE } from './ksan'
import { gatesFromSurface, type Airport } from './airport'
import type { Point } from './types'
import type { Rng } from '../random'
import type { ServicingConfig } from '../ground/sim'
import type { ActiveRunway, RunwayLayout } from '../ground/runway'
import type { WakeCategory } from '../ground/types'

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

/** San Diego International — the first airport, and the reference for the {@link Airport} shape. */
export const KSAN: Airport = {
  icao: 'KSAN',
  name: 'SAN DIEGO INTL',
  surface: KSAN_SURFACE,
  // 27 first: it is the normal configuration, and this order drives the destination list.
  runways: [KSAN_RUNWAYS['27'], KSAN_RUNWAYS['09']],
  defaultRunway: '27',
  layout: KSAN_RUNWAY_LAYOUT,
  // Passenger terminal gates from OSM gate nodes (Terminal 2 = 20–51, Terminal 1 = 101–119).
  // Cargo and remote stands are not tagged as gates, so they are excluded from spawning.
  gates: gatesFromSurface(KSAN_SURFACE),
  servicing: SERVICING,
  comms: { ground: '123.9', tower: '118.3', atis: '134.8' },
  traffic: { intervalSec: 22, maxAircraft: 12, initialDepartures: 3 },
  identity,
  // Terminal 2's centroid sits over its own stands; nudge the label clear of them.
  areaLabelOffsetsNm: {
    'Terminal 2 West': [0, -0.05],
    'Terminal 2 East': [0, -0.05],
  },
}
