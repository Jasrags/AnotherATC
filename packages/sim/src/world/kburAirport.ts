import { KBUR_SURFACE } from './kbur'
import { gatesFromSurface, type Airport, type RunwayDependency } from './airport'
import type { Point } from './types'
import type { Rng } from '../random'
import type { ServicingConfig } from '../ground/sim'
import type { ActiveRunway, RunwayLayout } from '../ground/runway'
import type { WakeCategory } from '../ground/types'
import { lookupAircraftType } from '../ground/aircraftTypes'

/**
 * Hollywood Burbank (KBUR) — the second airport, and the first with **two runways that cross**.
 * The surveyed facts are in docs/BUR/runways.md; the crossing (08/26 × 15/33, at 66% / 79% along)
 * is the reason the field was chosen. Every number here that would be wrong at another field comes
 * off that write-up, per the airport/engine split in CLAUDE.md.
 *
 * The field is single-active-runway in the game today (like KSAN): one direction is in use and both
 * arrivals and departures share it. What is new is that the *other* physical runway exists — it is
 * drawn, `runwayIdAt` names it, and the declared {@link RunwayDependency} couples the two at the
 * crossing so a clearance on one runway sees traffic traversing the intersection on the other.
 * Two-runways-active-at-once is the next slice (docs/atc-multi-runway.md §5).
 */

/** The airline turnaround, and the field's default. BUR is an all-narrowbody field — the runways
 *  are short — so there is no widebody servicing tempo to state. */
const SERVICING: ServicingConfig = {
  services: [
    { kind: 'fuel', sec: 42 },
    { kind: 'cargo', sec: 30 },
    { kind: 'catering', sec: 26 },
    { kind: 'water', sec: 18 },
    { kind: 'cabin', sec: 12 },
  ],
}

/** Each fleet lists only the ICAO type designators it flies; the wake category is looked up from
 *  the sim-owned catalog so there is one source of truth for what a B738 is. */
function drawType(rng: Rng, designators: readonly string[], fallback: string): { type: string; wake: WakeCategory } {
  const type = designators[rng.int(0, designators.length - 1)] ?? fallback
  return { type, wake: lookupAircraftType(type).wake }
}

// The carriers that serve BUR, Southwest heaviest among them. All narrowbody — the two runways
// (5,802 / 6,886 ft) do not take a widebody, so the fleet is 737 / A320-family / regional jet.
const AIRLINES = ['SWA', 'AAL', 'UAL', 'DAL', 'ASA', 'JBU', 'NKS']
const AIRLINE_TYPES: readonly string[] = ['B738', 'B737', 'A320', 'A321', 'A20N', 'E75L', 'CRJ7', 'CRJ9']

function identity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const airline = AIRLINES[rng.int(0, AIRLINES.length - 1)] ?? 'SWA'
  return { callsign: `${airline}${rng.int(100, 1899)}`, ...drawType(rng, AIRLINE_TYPES, 'B738') }
}

/**
 * The two runways, from the FAA survey (docs/BUR/runways.md), in local nm from the ARP
 * (x = east, y = north). 08/26 has no displaced thresholds; 15/33 has both (909 ft / 350 ft), so
 * on 15/33 the landing threshold is not the pavement end.
 */
const RWY = {
  end08: [-0.5199, -0.167] as Point, // 08 threshold = physical west end (no displacement)
  end26: [0.4321, -0.1826] as Point, // 26 threshold = physical east end (no displacement)
  end15: [-0.089, 0.699] as Point, // 15 physical NW end (departure start)
  thr15: [-0.0557, 0.5529] as Point, // 15 landing threshold — displaced 909 ft
  end33: [0.1636, -0.4074] as Point, // 33 physical SE end (departure start)
  thr33: [0.1507, -0.3511] as Point, // 33 landing threshold — displaced 350 ft
}

/**
 * The four runway configurations. 08 is the only precision end (ILS/MALSR/PAPI, 3.0°) and the
 * default; the others are the reciprocals and the crossing runway. Glide paths and pattern sides
 * are the published ones (26 has no VGSI, so a nominal 3.0°).
 */
export const KBUR_RUNWAYS: Record<'08' | '26' | '15' | '33', ActiveRunway> = {
  '08': {
    ident: '08',
    threshold: RWY.end08,
    departureStart: RWY.end08,
    farEnd: RWY.end26,
    toraFt: 5801,
    ldaFt: 5801,
    glidePathDeg: 3.0,
    pattern: 'right', // BUR 08 flies a right-hand pattern
  },
  '26': {
    ident: '26',
    threshold: RWY.end26,
    departureStart: RWY.end26,
    farEnd: RWY.end08,
    toraFt: 5801,
    ldaFt: 5801,
    glidePathDeg: 3.0,
    pattern: 'left',
  },
  '15': {
    ident: '15',
    threshold: RWY.thr15,
    departureStart: RWY.end15,
    farEnd: RWY.end33,
    toraFt: 6885,
    ldaFt: 5976, // 6,885 − 909 ft displacement
    glidePathDeg: 3.25,
    pattern: 'right',
  },
  '33': {
    ident: '33',
    threshold: RWY.thr33,
    departureStart: RWY.end33,
    farEnd: RWY.end15,
    toraFt: 6885,
    ldaFt: 6535, // 6,885 − 350 ft displacement
    glidePathDeg: 3.2,
    pattern: 'left',
  },
}

/**
 * Runway 08/26 as painted. The EMAS bed is at the **east** end — the FAA remark reads "EMAS 170 FT
 * LENGTH BY 350 FT WIDTH LCTD AT THE DER 08", and the departure end of runway 08 (heading 091°) is
 * the east end. It arrests aircraft overrunning eastward, i.e. landing or rejecting on 08.
 */
export const KBUR_LAYOUT_0826: RunwayLayout = {
  ident: '08/26',
  widthFt: 150,
  ends: [
    { ident: '08', pavementEnd: RWY.end08, threshold: RWY.end08, emas: null },
    { ident: '26', pavementEnd: RWY.end26, threshold: RWY.end26, emas: { lengthFt: 170, widthFt: 350 } },
  ],
}

/** Runway 15/33 as painted — both thresholds displaced, no EMAS. */
export const KBUR_LAYOUT_1533: RunwayLayout = {
  ident: '15/33',
  widthFt: 150,
  ends: [
    { ident: '15', pavementEnd: RWY.end15, threshold: RWY.thr15, emas: null },
    { ident: '33', pavementEnd: RWY.end33, threshold: RWY.thr33, emas: null },
  ],
}

/**
 * The crossing. 08/26 and 15/33 cross at 66% / 79% along, so traffic committed to one runway
 * occupies the intersection the other runs through — an `occupancy` coupling. The `crossing` point
 * (the surveyed intersection, docs/BUR/runways.md §0) makes the coupling **position-aware**: a
 * departure or rollout holds the other runway only until it is past that point, not for its whole
 * roll. Not `wake`-coupled: crossing departures do not share a wake corridor.
 */
const CROSSING: RunwayDependency = {
  runways: ['08/26', '15/33'],
  kinds: ['occupancy'],
  crossing: [0.1111, -0.1773],
}

/** Hollywood Burbank — the second airport, and the reference for an intersecting two-runway field. */
export const KBUR: Airport = {
  icao: 'KBUR',
  name: 'HOLLYWOOD BURBANK',
  surface: KBUR_SURFACE,
  // 08 first: the precision end and the default. All four directions are offered as taxi
  // destinations and as the switchable active runway.
  runways: [KBUR_RUNWAYS['08'], KBUR_RUNWAYS['26'], KBUR_RUNWAYS['15'], KBUR_RUNWAYS['33']],
  defaultRunway: '08',
  layouts: [KBUR_LAYOUT_0826, KBUR_LAYOUT_1533],
  runwayDependencies: [CROSSING],
  // One airline fleet at the passenger terminal (gates A1–A9, B1–B5, all SE of the field). BUR's
  // GA/charter traffic parks at remote stands OSM does not tag as gate nodes, so it has no fleet
  // yet — a scenario question for later, like KSAN's freight apron.
  fleets: [{ kind: 'airline', weight: 1, gates: gatesFromSurface(KBUR_SURFACE), types: AIRLINE_TYPES, identity }],
  servicing: SERVICING,
  comms: { ground: '123.9', tower: '118.7', atis: '134.5' },
  traffic: { intervalSec: 24, maxAircraft: 12, initialDepartures: 3 },
  // Approximate: the terminal sits near the runways, so a departure crosses the field faster than
  // at KSAN (~4–5 min clearance → hold-short). The lead starts above that. Re-measure the field if
  // slots start biting on taxi time rather than on flow.
  slots: { rate: 0.3, leadMinSec: 6 * 60, leadMaxSec: 12 * 60 },
}
