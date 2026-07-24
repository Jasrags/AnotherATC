import surface from './koak.surface.json'
import { validateSurface } from './validateSurface'

/**
 * KOAK (Oakland San Francisco Bay Intl) airport surface geometry, projected to local nm.
 * Generated from OpenStreetMap data — see tools/ingest/build-koak-surface.mjs and docs/OAK/.
 * Validated on load so malformed/regenerated data fails fast instead of feeding NaN geometry
 * into the deterministic core.
 */
export const KOAK_SURFACE = validateSurface(surface)
