import surface from './kbur.surface.json'
import { validateSurface } from './validateSurface'

/**
 * KBUR (Hollywood Burbank / Bob Hope) airport surface geometry, projected to local nm.
 * Generated from OpenStreetMap data — see tools/ingest/build-kbur-surface.mjs and docs/BUR/.
 * Validated on load so malformed/regenerated data fails fast instead of feeding NaN geometry
 * into the deterministic core.
 */
export const KBUR_SURFACE = validateSurface(surface)
