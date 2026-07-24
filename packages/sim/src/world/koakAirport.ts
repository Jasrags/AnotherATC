import { KOAK_SURFACE } from './koak'
import { gatesFromSurface, type Airport, type RunwayDependency } from './airport'
import type { Point } from './types'
import type { Rng } from '../random'
import type { ServicingConfig } from '../ground/sim'
import type { ActiveRunway, RunwayLayout } from '../ground/runway'
import type { WakeCategory } from '../ground/types'
import { lookupAircraftType } from '../ground/aircraftTypes'

/**
 * Oakland (KOAK) — the third airport, and the first with **parallel runways**. Where KBUR's two
 * runways *cross*, KOAK's two close parallels (10L/28R and 10R/28L) never touch: they are 1,001 ft
 * apart (docs/OAK/runways.md §0), well under the ~2,500 ft independent-approach threshold, so they
 * are **dependent** — a `wake`/`landing` coupling rather than KBUR's `occupancy` crossing. Every
 * number here that would be wrong at another field comes off that write-up, per the airport/engine
 * split in CLAUDE.md.
 *
 * Four physical runways, two fields: the North Field carries the two parallels and the short
 * crosswind 15/33; the air-carrier runway 12/30 is the South Field, ~1 nm southwest, with the
 * passenger terminal beside it. The field loads on **30** (the terminal's own runway, a short
 * taxi); activating a parallel is what exercises the dependent-parallel coupling, and the wake half
 * of it is honoured today (the sim already shares a wake corridor across `wake`-coupled runways).
 * The arrival-staggering half (`landing`) is declared here but is the next engine slice — see
 * docs/atc-multi-runway.md §6 and the backlog.
 */

/** The airline turnaround, and the field's default. KOAK's passenger terminal is narrowbody —
 *  Southwest-dominated — so there is no widebody servicing tempo to state (the freighters that use
 *  12/30's length park on the cargo ramp, which OSM does not tag as gate nodes; no fleet yet). */
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

// The carriers at OAK's passenger terminal, Southwest heaviest by far (OAK is a major SWA focus
// city) — listed repeatedly to weight the draw. All narrowbody: the terminal gates take 737 /
// A320-family / regional jets. Freight (OAK is a large FedEx hub) parks on the cargo ramp and has
// no gate nodes, so it is a later fleet — like KBUR's GA and KSAN's freight apron.
const AIRLINES = ['SWA', 'SWA', 'SWA', 'AAL', 'DAL', 'ASA', 'JBU', 'NKS', 'UAL']
const AIRLINE_TYPES: readonly string[] = ['B738', 'B737', 'A320', 'A321', 'A20N', 'E75L']

function identity(rng: Rng): { callsign: string; type: string; wake: WakeCategory } {
  const airline = AIRLINES[rng.int(0, AIRLINES.length - 1)] ?? 'SWA'
  return { callsign: `${airline}${rng.int(100, 1899)}`, ...drawType(rng, AIRLINE_TYPES, 'B738') }
}

/**
 * The eight runway ends, from the FAA survey (docs/OAK/runways.md §5), in local nm from the ARP
 * (x = east, y = north). Only 30 has a displaced threshold (114 ft); on every other end the landing
 * threshold is the pavement end.
 */
const RWY = {
  end10L: [-0.0489, 0.5525] as Point, // 10L threshold = physical NW end (no displacement)
  end28R: [0.7803, 0.2132] as Point, // 28R threshold = physical SE end
  end10R: [-0.2255, 0.4468] as Point, // 10R threshold = physical NW end
  end28L: [0.7186, 0.0607] as Point, // 28L threshold = physical SE end
  end12: [-0.995, -0.0719] as Point, // 12 threshold = physical NW end
  end30: [0.3271, -1.1861] as Point, // 30 physical SE end (departure start)
  thr30: [0.3128, -1.174] as Point, // 30 landing threshold — displaced 114 ft
  end15: [-0.0787, 1.1419] as Point, // 15 threshold = physical N end
  end33: [0.0701, 0.6061] as Point, // 33 threshold = physical S end
}

/**
 * The eight runway configurations. Only precision ends carry an ILS: **28R** on the parallels, and
 * **12/30** on the South Field (30 is CAT II/III). Glide paths and pattern sides are the published
 * ones; the two 15/33 ends have no VGSI, so a nominal 3.0°. 10L's LDA (5,336) is a declared
 * reduction with no displaced threshold (docs/OAK/runways.md §1).
 */
export const KOAK_RUNWAYS: Record<'10L' | '28R' | '10R' | '28L' | '12' | '30' | '15' | '33', ActiveRunway> = {
  '28R': {
    ident: '28R',
    threshold: RWY.end28R,
    departureStart: RWY.end28R,
    farEnd: RWY.end10L,
    toraFt: 5457,
    ldaFt: 5457,
    glidePathDeg: 3.0,
    pattern: 'right', // 28R flies a right-hand pattern; the only ILS on the parallels
  },
  '10L': {
    ident: '10L',
    threshold: RWY.end10L,
    departureStart: RWY.end10L,
    farEnd: RWY.end28R,
    toraFt: 5457,
    ldaFt: 5336, // declared reduction, no displaced threshold
    glidePathDeg: 3.0,
    pattern: 'left',
  },
  '28L': {
    ident: '28L',
    threshold: RWY.end28L,
    departureStart: RWY.end28L,
    farEnd: RWY.end10R,
    toraFt: 6213,
    ldaFt: 6213,
    glidePathDeg: 3.0,
    pattern: 'left',
  },
  '10R': {
    ident: '10R',
    threshold: RWY.end10R,
    departureStart: RWY.end10R,
    farEnd: RWY.end28L,
    toraFt: 6213,
    ldaFt: 6213,
    glidePathDeg: 3.0,
    pattern: 'left',
  },
  '30': {
    ident: '30',
    threshold: RWY.thr30,
    departureStart: RWY.end30,
    farEnd: RWY.end12,
    toraFt: 10000, // declared; the pavement is 10,520 ft with a 400×220 blast pad each end
    ldaFt: 10000,
    glidePathDeg: 3.0,
    pattern: 'left', // the CAT II/III end (ALSF-2, ILS/DME)
  },
  '12': {
    ident: '12',
    threshold: RWY.end12,
    departureStart: RWY.end12,
    farEnd: RWY.end30,
    toraFt: 10000,
    ldaFt: 10000,
    glidePathDeg: 2.75,
    pattern: 'right',
  },
  '15': {
    ident: '15',
    threshold: RWY.end15,
    departureStart: RWY.end15,
    farEnd: RWY.end33,
    toraFt: 3376,
    ldaFt: 3376,
    glidePathDeg: 3.0, // nominal — no VGSI
    pattern: 'left',
  },
  '33': {
    ident: '33',
    threshold: RWY.end33,
    departureStart: RWY.end33,
    farEnd: RWY.end15,
    toraFt: 3376,
    ldaFt: 3376,
    glidePathDeg: 3.0, // nominal — no VGSI
    pattern: 'right',
  },
}

/** Runway 10L/28R as painted — no displaced thresholds, no EMAS. The shorter North parallel. */
export const KOAK_LAYOUT_10L28R: RunwayLayout = {
  ident: '10L/28R',
  widthFt: 150,
  ends: [
    { ident: '10L', pavementEnd: RWY.end10L, threshold: RWY.end10L, emas: null },
    { ident: '28R', pavementEnd: RWY.end28R, threshold: RWY.end28R, emas: null },
  ],
}

/**
 * Runway 10R/28L as painted. The EMAS bed is at the **west** end — the FAA remark reads "EMAS 162
 * FT LENGTH BY 154 FT WIDTH LCTD AT THE DER 28L", and the departure end of runway 28L (heading
 * 292°) is the west end, at the 10R threshold side. It arrests westbound overruns: a landing or
 * reject on 28L.
 */
export const KOAK_LAYOUT_10R28L: RunwayLayout = {
  ident: '10R/28L',
  widthFt: 150,
  ends: [
    { ident: '10R', pavementEnd: RWY.end10R, threshold: RWY.end10R, emas: { lengthFt: 162, widthFt: 154 } },
    { ident: '28L', pavementEnd: RWY.end28L, threshold: RWY.end28L, emas: null },
  ],
}

/** Runway 12/30 as painted — the South-Field air-carrier runway. 30's threshold is displaced 114
 *  ft; no EMAS (both ends have a 400×220 ft blast pad, which is not modelled pavement). */
export const KOAK_LAYOUT_1230: RunwayLayout = {
  ident: '12/30',
  widthFt: 150,
  ends: [
    { ident: '12', pavementEnd: RWY.end12, threshold: RWY.end12, emas: null },
    { ident: '30', pavementEnd: RWY.end30, threshold: RWY.thr30, emas: null },
  ],
}

/** Runway 15/33 as painted — the short (75 ft wide) North-Field crosswind, no displacements, no EMAS. */
export const KOAK_LAYOUT_1533: RunwayLayout = {
  ident: '15/33',
  widthFt: 75,
  ends: [
    { ident: '15', pavementEnd: RWY.end15, threshold: RWY.end15, emas: null },
    { ident: '33', pavementEnd: RWY.end33, threshold: RWY.end33, emas: null },
  ],
}

/**
 * The dependent parallels. 10L/28R and 10R/28L are 1,001 ft apart (docs/OAK/runways.md §0) — under
 * the ~2,500 ft independent-approach threshold, so arrivals to one bear on arrivals to the other,
 * and the pair shares a wake corridor. Coupled by `wake` (honoured by the sim today) and `landing`
 * (the arrival-staggering rule, declared here but pending — docs/atc-multi-runway.md §6). **Not**
 * `occupancy`-coupled: nothing crosses, so a movement on one runway never occupies the other, and
 * there is no `crossing` point — the coupling stays the coarse boolean.
 */
const PARALLELS: RunwayDependency = {
  runways: ['10L/28R', '10R/28L'],
  kinds: ['wake', 'landing'],
}

/** Oakland — the third airport, and the reference for a dependent-parallel two-runway field. */
export const KOAK: Airport = {
  icao: 'KOAK',
  name: 'OAKLAND INTL',
  surface: KOAK_SURFACE,
  // 30 first and default: the air-carrier runway beside the terminal, a short taxi and the clean
  // base loop. The parallels follow (28R the precision end), then the crosswind — all offered as
  // taxi destinations and as switchable active runways. Activating a parallel is what exercises the
  // dependent coupling.
  runways: [
    KOAK_RUNWAYS['30'],
    KOAK_RUNWAYS['12'],
    KOAK_RUNWAYS['28R'],
    KOAK_RUNWAYS['10L'],
    KOAK_RUNWAYS['28L'],
    KOAK_RUNWAYS['10R'],
    KOAK_RUNWAYS['15'],
    KOAK_RUNWAYS['33'],
  ],
  defaultRunway: '30',
  layouts: [KOAK_LAYOUT_10L28R, KOAK_LAYOUT_10R28L, KOAK_LAYOUT_1230, KOAK_LAYOUT_1533],
  runwayDependencies: [PARALLELS],
  // One airline fleet at the South-Field passenger terminal (gates 1–32, all beside 12/30). Cargo
  // (a large FedEx hub) and GA park on ramps OSM does not tag as gate nodes, so they have no fleet
  // yet — a scenario question for later, like KSAN's freight apron and KBUR's charter stands.
  fleets: [{ kind: 'airline', weight: 1, gates: gatesFromSurface(KOAK_SURFACE), types: AIRLINE_TYPES, identity }],
  servicing: SERVICING,
  // OAK runs split North/South tower & ground frequencies (00294AD.PDF): South Field (12/30, the
  // terminal) is TWR 127.2 / GND 121.75; the North Field parallels are TWR 118.3 / GND 121.9. The
  // single-comms bundle can't express the split, so it carries the South-Field pair the fleet uses.
  // D-ATIS 133.775, Clearance Delivery 121.1. The N/S split is a real feature to model later.
  comms: { ground: '121.75', tower: '127.2', atis: '133.775' },
  traffic: { intervalSec: 24, maxAircraft: 14, initialDepartures: 3 },
  // Approximate. Default 30 is a short taxi from the terminal, but activating a North parallel makes
  // the gate→runway taxi much longer, so the lead is set generous and flagged: re-measure the field
  // (clearance → hold-short) in play and tighten if slots bite on taxi rather than on flow.
  slots: { rate: 0.25, leadMinSec: 8 * 60, leadMaxSec: 16 * 60 },
}
