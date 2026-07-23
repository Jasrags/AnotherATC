import type { WakeCategory } from './types'

/**
 * The physical capabilities of an aircraft type that the sim reads to fly it.
 *
 * Sim-owned and airport-independent: a B738 has the same wake category, approach speed and taxi
 * speed at every field, exactly like the wake-separation matrix in wake.ts. This is the "a rule
 * that applies wherever the rule applies is the engine's" side of the airport/engine split — the
 * Airport bundle chooses *which* designators fly its ramps; this catalog says what each one can
 * do. See CLAUDE.md, "The airport/engine split".
 */
export interface AircraftType {
  /** ICAO wake-turbulence category. The one capability with a live consumer today: the Tower
   *  successive-departure release gate (wake.ts / sim.ts). */
  wake: WakeCategory
  /** Final-approach speed (kt) across the landing threshold. The lever on runway occupancy: a
   *  faster type arrives at each turnoff faster and so makes fewer of the early ones. Fed to
   *  chooseExit()/cannotMake() in runwayExits.ts, which already brake down from this speed — so
   *  the "a Heavy takes a later turnoff than a Light" behaviour falls out of geometry already in
   *  place, rather than a second label. */
  approachKt: number
  /** Normal straight-taxi speed (kt). A type fact recorded here now; the ground taxi loop still
   *  runs on a single global TAXI_SPEED_KT and will read this in a later slice. */
  taxiKt: number
  /** Shortest runway (ft) the type needs to operate. INERT at KSAN: the field is a single
   *  ~9,400 ft runway every one of these clears, so nothing reads this yet. It lives here because
   *  it is a fact about the *type*, not the field — the first short-runway or multi-runway
   *  airport switches on a consumer with no data migration. */
  minRwyFt: number
}

/**
 * Every aircraft type the KSAN fleets fly, keyed by ICAO type designator.
 *
 * approachKt is the deliberate spread — Lights cross the threshold ~65–108 kt, Mediums ~113–142,
 * Heavies ~140–145 — because that spread is what makes two arrivals occupy the runway for
 * measurably different times through the exit model. The numbers are game-reasonable Vref-family
 * values, not certified performance data (docs win over realism).
 */
export const AIRCRAFT_TYPES: Readonly<Record<string, AircraftType>> = {
  // ── Airline (Medium jets) ──
  B738: { wake: 'M', approachKt: 140, taxiKt: 15, minRwyFt: 5800 },
  A320: { wake: 'M', approachKt: 138, taxiKt: 15, minRwyFt: 5700 },
  A321: { wake: 'M', approachKt: 142, taxiKt: 15, minRwyFt: 6200 },
  B739: { wake: 'M', approachKt: 142, taxiKt: 15, minRwyFt: 6000 },
  A20N: { wake: 'M', approachKt: 138, taxiKt: 15, minRwyFt: 5600 },
  E75L: { wake: 'M', approachKt: 135, taxiKt: 14, minRwyFt: 4600 },
  CRJ7: { wake: 'M', approachKt: 137, taxiKt: 14, minRwyFt: 5300 },
  // ── Cargo (Heavies and regional freighters) ──
  B763: { wake: 'H', approachKt: 145, taxiKt: 14, minRwyFt: 7500 },
  A306: { wake: 'H', approachKt: 140, taxiKt: 14, minRwyFt: 7500 },
  B752: { wake: 'M', approachKt: 135, taxiKt: 15, minRwyFt: 6000 },
  AT76: { wake: 'M', approachKt: 113, taxiKt: 12, minRwyFt: 3600 },
  C208: { wake: 'L', approachKt: 85, taxiKt: 11, minRwyFt: 2000 },
  // ── General aviation (Lights) ──
  C172: { wake: 'L', approachKt: 65, taxiKt: 10, minRwyFt: 1600 },
  SR22: { wake: 'L', approachKt: 75, taxiKt: 11, minRwyFt: 1800 },
  PC12: { wake: 'L', approachKt: 90, taxiKt: 12, minRwyFt: 2400 },
  BE20: { wake: 'L', approachKt: 103, taxiKt: 12, minRwyFt: 2600 },
  C560: { wake: 'L', approachKt: 108, taxiKt: 13, minRwyFt: 3400 },
}

/** What an unknown designator falls back to: a plain Medium narrowbody. Hand-authored fixtures
 *  and the dev sandbox can name any type string; this keeps a typo or a one-off from crashing the
 *  sim, and matches the historical default the spawner used for an unresolved type. */
export const DEFAULT_AIRCRAFT_TYPE: AircraftType = { wake: 'M', approachKt: 140, taxiKt: 15, minRwyFt: 5800 }

/** The capabilities of an aircraft type by ICAO designator, or {@link DEFAULT_AIRCRAFT_TYPE} for
 *  anything the catalog does not know. Never throws — an unrecognised type is a fallback, not an
 *  error, because `type` is a free string on AircraftInit for hand-authored aircraft. */
export function lookupAircraftType(designator: string): AircraftType {
  return AIRCRAFT_TYPES[designator] ?? DEFAULT_AIRCRAFT_TYPE
}
