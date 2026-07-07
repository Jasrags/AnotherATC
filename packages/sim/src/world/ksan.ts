import surface from './ksan.surface.json'
import { validateSurface } from './validateSurface'

/**
 * KSAN (San Diego Intl) airport surface geometry, projected to local nm.
 * Generated from OpenStreetMap data — see tools/ingest/build-ksan-surface.mjs.
 * Validated on load so malformed/regenerated data fails fast instead of feeding
 * NaN geometry into the deterministic core.
 */
export const KSAN_SURFACE = validateSurface(surface)
