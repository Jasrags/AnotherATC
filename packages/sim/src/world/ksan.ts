import surface from './ksan.surface.json'
import type { AirportSurface } from './types'

/**
 * KSAN (San Diego Intl) airport surface geometry, projected to local nm.
 * Generated from OpenStreetMap data — see tools/ingest/build-ksan-surface.mjs.
 */
export const KSAN_SURFACE = surface as unknown as AirportSurface
