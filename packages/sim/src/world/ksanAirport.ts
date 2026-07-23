import { KSAN_SURFACE } from './ksan'
import { gatesFromSurface, standsAsGates, type Airport } from './airport'
import type { Point } from './types'
import type { Rng } from '../random'
import type { ServicingConfig } from '../ground/sim'
import type { ActiveRunway, RunwayLayout } from '../ground/runway'
import type { WakeCategory } from '../ground/types'
import { lookupAircraftType } from '../ground/aircraftTypes'

/**
 * Pre-push ground services, run in parallel (game seconds). Fueling is the long pole, so it
 * sets when pushback unlocks; the shorter services finish earlier. Tuned for surface pacing.
 *
 * This is the *airline* turnaround, and the field's default. The other two fleets state their
 * own below: what an aircraft needs before it can leave is a fact about the aircraft, and a
 * single profile had a Cessna waiting on a catering truck.
 */
const SERVICING: ServicingConfig = {
  services: [
    { kind: 'fuel', sec: 45 },
    { kind: 'cargo', sec: 34 },
    { kind: 'catering', sec: 28 },
    { kind: 'water', sec: 20 },
    { kind: 'cabin', sec: 13 },
  ],
}

/** A freighter is loading freight — that is the long pole, and it is longer than an airliner's
 *  fuel. No cabin, no catering, nobody to board. Freighters are also this field's Heavies and
 *  they park across the runway, so time on stand is pressure on the crossing, not just a clock. */
const CARGO_SERVICING: ServicingConfig = {
  services: [
    { kind: 'freight', sec: 68 },
    { kind: 'fuel', sec: 38 },
  ],
}

/** A light single takes fuel and a walk-round. It is on the ramp for a fraction of a turnaround
 *  and should feel like it: traffic that appears, pushes and goes. */
const GA_SERVICING: ServicingConfig = {
  services: [
    { kind: 'fuel', sec: 16 },
    { kind: 'preflight', sec: 9 },
  ],
}

/** Each fleet lists only the ICAO type designators it flies; the wake category (and every other
 *  capability) is looked up from the sim-owned catalog so there is one source of truth for what a
 *  B763 is. See aircraftTypes.ts and the airport/engine split in CLAUDE.md. */
function drawType(rng: Rng, designators: readonly string[], fallback: string): { type: string; wake: WakeCategory } {
  const type = designators[rng.int(0, designators.length - 1)] ?? fallback
  return { type, wake: lookupAircraftType(type).wake }
}

const AIRLINES = ['AAL', 'UAL', 'DAL', 'SWA', 'ASA', 'NKS', 'JBU', 'SKW']
const AIRLINE_TYPES: readonly string[] = ['B738', 'A320', 'A321', 'B739', 'A20N', 'E75L', 'CRJ7', 'B763']

function identity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const airline = AIRLINES[rng.int(0, AIRLINES.length - 1)] ?? 'AAL'
  return { callsign: `${airline}${rng.int(100, 1899)}`, ...drawType(rng, AIRLINE_TYPES, 'B738') }
}

/** The freight operators that serve SAN, and what they bring. Heavier on average than the
 *  airline fleet — which is the point: a Heavy on the North Ramp puts a real wake interval
 *  behind it, and the aircraft behind it is often a Light off the GA ramp. */
const CARGO_OPERATORS = ['FDX', 'UPS', 'GTI', 'CLX']
const CARGO_TYPES: readonly string[] = ['B763', 'A306', 'B752', 'AT76', 'C208']

function cargoIdentity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const operator = CARGO_OPERATORS[rng.int(0, CARGO_OPERATORS.length - 1)] ?? 'FDX'
  return { callsign: `${operator}${rng.int(100, 1899)}`, ...drawType(rng, CARGO_TYPES, 'B763') }
}

/** General aviation: N-numbers rather than an operator code, and light types. */
const GA_TYPES: readonly string[] = ['C172', 'SR22', 'PC12', 'BE20', 'C560']
const GA_SUFFIX = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I or O — they read as 1 and 0

function gaIdentity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const letter = (i: number): string => GA_SUFFIX[i] ?? 'A'
  const tail = `N${rng.int(100, 999)}${letter(rng.int(0, GA_SUFFIX.length - 1))}${letter(rng.int(0, GA_SUFFIX.length - 1))}`
  return { callsign: tail, ...drawType(rng, GA_TYPES, 'C172') }
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
    { kind: 'airline', weight: 10, gates: gatesFromSurface(KSAN_SURFACE), types: AIRLINE_TYPES, identity },
    {
      kind: 'cargo',
      weight: 2,
      gates: standsAsGates(KSAN_SURFACE, (s) => NORTH_RAMP.has(s.ref)),
      types: CARGO_TYPES,
      identity: cargoIdentity,
      servicing: CARGO_SERVICING,
    },
    {
      kind: 'ga',
      weight: 2,
      gates: standsAsGates(KSAN_SURFACE, (s) => GA_RAMP.has(s.ref)),
      types: GA_TYPES,
      identity: gaIdentity,
      servicing: GA_SERVICING,
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
