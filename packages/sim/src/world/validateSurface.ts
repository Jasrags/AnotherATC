import type { AirportSurface, SurfaceKind } from './types'

/**
 * Runtime validation for airport surface data at the point it enters the sim.
 *
 * The surface JSON is machine-generated (tools/ingest/build-ksan-surface.mjs) and
 * force-cast on import, so a regeneration bug or malformed OSM re-fetch could otherwise
 * push NaN coordinates or missing geometry silently into the deterministic core — where
 * a NaN distance degrades to `null` routes rather than a loud failure. This fails fast
 * with a clear message instead. See docs/code-review-baseline.md (SIM-4 / ING-*).
 */

const KINDS: ReadonlySet<string> = new Set<SurfaceKind>([
  'aerodrome',
  'apron',
  'terminal',
  'hangar',
  'runway',
  'stopway',
  'taxiway',
  'taxilane',
  'parking_position',
  'holding_position',
  'gate',
])

class SurfaceValidationError extends Error {
  constructor(message: string) {
    super(`Invalid airport surface: ${message}`)
    this.name = 'SurfaceValidationError'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function checkPoint(p: unknown, where: string): void {
  if (!Array.isArray(p) || p.length !== 2) {
    throw new SurfaceValidationError(`${where}: expected a [x, y] point, got ${JSON.stringify(p)}`)
  }
  if (!finite(p[0]) || !finite(p[1])) {
    throw new SurfaceValidationError(`${where}: coordinates must be finite, got ${JSON.stringify(p)}`)
  }
}

/**
 * Validate untrusted surface data and return it typed as `AirportSurface`.
 * Throws `SurfaceValidationError` (naming the offending part) on any malformed input.
 */
export function validateSurface(input: unknown): AirportSurface {
  if (!isRecord(input)) {
    throw new SurfaceValidationError(`expected an object, got ${input === null ? 'null' : typeof input}`)
  }

  for (const key of ['icao', 'name', 'units', 'source'] as const) {
    if (typeof input[key] !== 'string') {
      throw new SurfaceValidationError(`"${key}" must be a string`)
    }
  }

  const ref = input.ref
  if (!isRecord(ref) || !finite(ref.lat) || !finite(ref.lon) || !finite(ref.elevationFt)) {
    throw new SurfaceValidationError('"ref" must have finite lat, lon, and elevationFt')
  }

  const bounds = input.bounds
  if (!isRecord(bounds) || !finite(bounds.minX) || !finite(bounds.minY) || !finite(bounds.maxX) || !finite(bounds.maxY)) {
    throw new SurfaceValidationError('"bounds" must have finite minX, minY, maxX, maxY')
  }

  if (!Array.isArray(input.features) || input.features.length === 0) {
    throw new SurfaceValidationError('"features" must be a non-empty array')
  }

  input.features.forEach((f, i) => {
    if (!isRecord(f)) throw new SurfaceValidationError(`features[${i}] must be an object`)
    if (typeof f.kind !== 'string' || !KINDS.has(f.kind)) {
      throw new SurfaceValidationError(`features[${i}] has unknown kind ${JSON.stringify(f.kind)}`)
    }
    if (!Array.isArray(f.points) || f.points.length === 0) {
      throw new SurfaceValidationError(`features[${i}] (${f.kind}) must have a non-empty points array`)
    }
    f.points.forEach((p, j) => checkPoint(p, `features[${i}].points[${j}]`))
  })

  if (input.hotspots !== undefined) {
    if (!Array.isArray(input.hotspots)) throw new SurfaceValidationError('"hotspots" must be an array when present')
    input.hotspots.forEach((h, i) => {
      if (!isRecord(h) || typeof h.id !== 'string' || typeof h.label !== 'string' || !finite(h.radiusNm)) {
        throw new SurfaceValidationError(`hotspots[${i}] must have string id, string label, and finite radiusNm`)
      }
      checkPoint(h.point, `hotspots[${i}].point`)
    })
  }

  return input as unknown as AirportSurface
}
