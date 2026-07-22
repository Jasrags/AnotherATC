import { KSAN_SURFACE } from './ksan'
import { gatesFromSurface, standsAsGates, type Airport } from './airport'
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

/** The freight operators that serve SAN, and what they bring. Heavier on average than the
 *  airline fleet — which is the point: a Heavy on the North Ramp puts a real wake interval
 *  behind it, and the aircraft behind it is often a Light off the GA ramp. */
const CARGO_OPERATORS = ['FDX', 'UPS', 'GTI', 'CLX']
const CARGO_TYPES: readonly [string, WakeCategory][] = [
  ['B763', 'H'],
  ['A306', 'H'],
  ['B752', 'M'],
  ['AT76', 'M'],
  ['C208', 'L'],
]

function cargoIdentity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const operator = CARGO_OPERATORS[rng.int(0, CARGO_OPERATORS.length - 1)] ?? 'FDX'
  const [type, wake] = CARGO_TYPES[rng.int(0, CARGO_TYPES.length - 1)] ?? ['B763', 'H']
  return { callsign: `${operator}${rng.int(100, 1899)}`, type, wake }
}

/** General aviation: N-numbers rather than an operator code, and light types. */
const GA_TYPES: readonly [string, WakeCategory][] = [
  ['C172', 'L'],
  ['SR22', 'L'],
  ['PC12', 'L'],
  ['BE20', 'L'],
  ['C560', 'L'],
]
const GA_SUFFIX = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I or O — they read as 1 and 0

function gaIdentity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const [type, wake] = GA_TYPES[rng.int(0, GA_TYPES.length - 1)] ?? ['C172', 'L']
  const letter = (i: number): string => GA_SUFFIX[i] ?? 'A'
  const tail = `N${rng.int(100, 999)}${letter(rng.int(0, GA_SUFFIX.length - 1))}${letter(rng.int(0, GA_SUFFIX.length - 1))}`
  return { callsign: tail, type, wake }
}

/** The North Ramp — cargo and FBO parking, and the reason this field has runway crossings at
 *  all: it is on the far side of 09/27 from every passenger gate. */
const NORTH_RAMP = new Set(['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10'])
/** The east-side GA stands, also north of the runway. */
const GA_RAMP = new Set(['1', '2', '3', '4', '5'])

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
  // Three classes of traffic, and the parking each of them uses. The weights are movements,
  // not stands: the North Ramp and the GA apron are a good share of the field's parking and a
  // small share of its day. Both sit **north of runway 09/27**, while every passenger gate is
  // south of it — so this is also what makes a runway crossing an ordinary event here rather
  // than something you have to contrive. See docs/atc-runway-crossing.md.
  fleets: [
    { kind: 'airline', weight: 10, gates: gatesFromSurface(KSAN_SURFACE), identity },
    {
      kind: 'cargo',
      weight: 2,
      gates: standsAsGates(KSAN_SURFACE, (s) => NORTH_RAMP.has(s.ref)),
      identity: cargoIdentity,
    },
    {
      kind: 'ga',
      weight: 2,
      gates: standsAsGates(KSAN_SURFACE, (s) => GA_RAMP.has(s.ref)),
      identity: gaIdentity,
    },
  ],
  servicing: SERVICING,
  comms: { ground: '123.9', tower: '118.3', atis: '134.8' },
  traffic: { intervalSec: 22, maxAircraft: 12, initialDepartures: 3 },
  // Measured on this field: clearance → hold-short line is about seven minutes for a terminal
  // departure, servicing and pushback included. A slot inside that is not a constraint, it is a
  // guaranteed miss — so the lead starts above it and leaves room to be worked well or badly.
  slots: { rate: 0.35, leadMinSec: 8 * 60, leadMaxSec: 14 * 60 },
  // Terminal 2's centroid sits over its own stands; nudge the label clear of them.
  areaLabelOffsetsNm: {
    'Terminal 2 West': [0, -0.05],
    'Terminal 2 East': [0, -0.05],
  },
}
