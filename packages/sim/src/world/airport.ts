import { createRng } from '../random'
import { finalFix, FINAL_APPROACH_NM, type ActiveRunway, type RunwayLayout } from '../ground/runway'
import type {
  AircraftInit,
  GateSlot,
  ServicingConfig,
  SlotConfig,
  SpawnConfig,
  SpawnFleet,
} from '../ground/sim'
import type { NamedDestination } from '../ground/types'
import { buildStands, type Stand } from '../ground/stands'
import type { AirportSurface, Point } from './types'

/** Controller frequencies, for the scope header. */
export interface AirportComms {
  ground: string
  tower: string
  atis: string
}

/** How much traffic the field generates. */
export interface TrafficConfig {
  /** Seconds between spawn attempts. */
  intervalSec: number
  /** Cap on simultaneous aircraft. */
  maxAircraft: number
  /** Aircraft on stand at t=0, so the surface isn't empty. */
  initialDepartures: number
}

/**
 * Everything that makes one airport that airport.
 *
 * The engine holds no airport knowledge: it is handed a graph, a runway guard, a runway
 * configuration and a spawn config, and simulates whatever it is given. This bundle is the one
 * place a field's specifics live, so adding an airport is a data exercise rather than a
 * refactor. `packages/sim/src/world/airport.test.ts` proves that by building a fictional field
 * from scratch and running the whole game loop on it.
 */
export interface Airport {
  /** ICAO identifier, e.g. "KSAN". */
  icao: string
  /** Display name for the scope header, e.g. "SAN DIEGO INTL". */
  name: string
  surface: AirportSurface
  /**
   * The runway directions that can be made active, in display order. A single-runway field has
   * the two reciprocal directions of its one runway; exactly one is in use at a time.
   *
   * An array, not a record keyed by designator: JavaScript iterates integer-like object keys in
   * *numeric* order regardless of insertion order, so `{ '27': …, '09': … }` silently comes back
   * as 09 then 27. Runway order is meaningful here (it drives the destination list), so it is
   * stated rather than left to that.
   */
  runways: readonly ActiveRunway[]
  /** Which direction is active on load. */
  defaultRunway: string
  /** Both runway ends as painted, for the markings. */
  layout: RunwayLayout
  /** The classes of traffic this field generates, and where each of them parks. The first is
   *  used for the initial fill — the aircraft already on stand at t=0. */
  fleets: readonly SpawnFleet[]
  /** Pre-departure ground services; omit for a field that doesn't model them. */
  servicing: ServicingConfig
  /** Wheels-up time windows. The lead has to clear *this field's* taxi time, which is why it is
   *  stated here rather than in the engine — measure the field (clearance → hold-short line) and
   *  set it above that. Omit for a field the flow system does not constrain. */
  slots?: SlotConfig
  comms: AirportComms
  traffic: TrafficConfig
  /** Nudges (nm) for area labels whose centroid sits over pavement, keyed by label. */
  areaLabelOffsetsNm?: Record<string, Point>
}

/** The named runway direction, or undefined if this field has no such configuration. */
export function findRunway(airport: Airport, ident: string): ActiveRunway | undefined {
  return airport.runways.find((r) => r.ident === ident)
}

/** Stands from the surface, deduped by designator. The common case: a field whose gates are in
 *  the surface data needs no gate list of its own. Each slot is the stand's *nose stop* and the
 *  heading it parks on, taken from the painted lead-in line where the field has one — not the
 *  gate label node, which sits at the terminal a plane's length further in. */
export function gatesFromSurface(surface: AirportSurface): GateSlot[] {
  // Terminal gates — the airline fleet's stands. Remote parking is reached through
  // `standsAsGates`, because which traffic belongs on a freight apron is a scenario question
  // rather than a geometry one, and the answer is stated per fleet.
  return standsAsGates(surface, (s) => s.kind === 'terminal')
}

/** The stands matching `pick`, as spawn slots. How a fleet names the parking it uses. */
export function standsAsGates(surface: AirportSurface, pick: (stand: Stand) => boolean): GateSlot[] {
  return buildStands(surface)
    .filter(pick)
    .map((s) => ({ ref: s.ref, point: s.stop, headingDeg: s.headingDeg }))
}

export interface AirportGame {
  inits: AircraftInit[]
  /** Painted lead-in geometry per stand — how an arrival gets onto a gate and a departure
   *  pushes back off it. */
  stands: Stand[]
  spawn: SpawnConfig
  destinations: NamedDestination[]
  servicing: ServicingConfig
  /** The field's slot policy, if it has one, with the game's seed folded in. */
  slots?: SlotConfig & { seed: number }
  runway: ActiveRunway
}

/**
 * Build a playable game for any airport: departures from stands to the active runway, arrivals
 * established on that same runway's final. Deterministic for a given seed.
 */
export function createAirportGame(airport: Airport, seed = 1, runwayIdent?: string): AirportGame {
  const runway =
    findRunway(airport, runwayIdent ?? airport.defaultRunway) ?? findRunway(airport, airport.defaultRunway)
  if (!runway) {
    throw new Error(`${airport.icao}: no runway configuration for "${runwayIdent ?? airport.defaultRunway}"`)
  }
  // A bundle is data, and data arrives wrong. Every one of these produced a silently dead field
  // — no traffic, no error, nothing to debug from — which is worse than a crash on line one.
  if (airport.fleets.length === 0) throw new Error(`${airport.icao}: no traffic fleets`)
  for (const f of airport.fleets) {
    if (f.gates.length === 0) throw new Error(`${airport.icao}: fleet "${f.kind}" has no stands`)
    // Finiteness matters more than it looks: NaN survives a `<= 0` check, poisons the weighted
    // total, and silently pins every draw to the last fleet in the list.
    if (!Number.isFinite(f.weight) || f.weight < 0) {
      throw new Error(`${airport.icao}: fleet "${f.kind}" has weight ${f.weight}, expected a finite share ≥ 0`)
    }
  }
  if (airport.fleets.reduce((sum, f) => sum + f.weight, 0) <= 0) {
    throw new Error(`${airport.icao}: every fleet has weight 0 — nothing would ever spawn`)
  }

  // Departures roll from the pavement end behind the threshold — the displaced portion is
  // theirs to use, it is only landings that may not touch down on it.
  const departureTarget = runway.departureStart

  const destinations: NamedDestination[] = airport.runways.map((r) => ({
    id: `rwy${r.ident}`,
    label: `RWY ${r.ident.replace(/^0/, '')}`,
    kind: 'runway',
    point: r.departureStart,
  }))

  const spawn: SpawnConfig = {
    fleets: airport.fleets,
    departureTarget,
    approach: { fix: finalFix(runway, FINAL_APPROACH_NM), threshold: runway.threshold },
    intervalSec: airport.traffic.intervalSec,
    maxAircraft: airport.traffic.maxAircraft,
    seed,
  }

  // The initial fill is scene-setting, and it comes from the first fleet: a field that opens
  // with its freight apron full and its gates empty is not the picture. The spawner mixes the
  // rest in from the first interval onward.
  const home = airport.fleets[0]!
  const inits: AircraftInit[] = home.gates
    .slice(0, airport.traffic.initialDepartures)
    .map((slot, i) => {
      // Deterministic initial identities, independent of the spawner's stream.
      const { callsign, type, wake } = home.identity(createRng(seed + i + 1))
      return {
        id: `init${i}`,
        callsign,
        type,
        wake,
        path: [slot.point],
        targetSpeed: 0,
        ...(slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
        intent: 'departure' as const,
        gate: slot.ref,
        goalPoint: departureTarget,
      }
    })

  return {
    inits,
    spawn,
    destinations,
    servicing: airport.servicing,
    // Its own sub-seed, not the game's: `createRng` is seed-determined, so handing two streams
    // the same integer makes them produce the same sequence call for call — which would tie
    // which flights get slots to what the spawner happened to draw. The initial-identity stream
    // above is salted for the same reason.
    ...(airport.slots ? { slots: { ...airport.slots, seed: seed + 7717 } } : {}),
    runway,
    stands: buildStands(airport.surface),
  }
}
