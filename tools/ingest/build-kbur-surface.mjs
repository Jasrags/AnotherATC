// Transforms the raw KBUR OpenStreetMap aeroway snapshot into the sim's surface
// data file, projecting lat/lon onto a local tangent plane (nm east/north from
// the airport reference point). One-time ingestion — no runtime external calls.
//
//   Regenerate:  node tools/ingest/build-kbur-surface.mjs
//   Re-fetch:    curl --data-urlencode "data@tools/ingest/kbur.overpass.ql" \
//                  -H "User-Agent: AnotherATC" \
//                  https://overpass-api.de/api/interpreter -o tools/ingest/kbur-osm.raw.json
//
// Source: OpenStreetMap contributors (ODbL). Overpass API.
//
// KBUR is the second field. See docs/BUR/README.md (chart index, cycle 2607) and
// docs/BUR/runways.md (surveyed NASR facts) for the authoritative data. Two things
// differ from KSAN and are documented there:
//   - Two runways that INTERSECT (08/26 × 15/33) at 66% / 79% along — the reason
//     the field was chosen. Geometry is drawn from OSM; the crossing rule is the sim's.
//   - 15/33 is split into three OSM ways; its 909 ft / 350 ft displaced-threshold
//     segments are the separately-tagged side pieces. Thresholds come from NASR,
//     never the OSM main-way endpoints (docs/BUR/runways.md §2).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const RAW = join(here, 'kbur-osm.raw.json')
const OUT = join(here, '..', '..', 'packages', 'sim', 'src', 'world', 'kbur.surface.json')

// KBUR airport reference point (ARP) and field elevation, from NASR APT_BASE.csv.
const REF = { lat: 34.20069444, lon: -118.35866666, elevationFt: 778 }

const NM_PER_DEG_LAT = 60
const NM_PER_DEG_LON = 60 * Math.cos((REF.lat * Math.PI) / 180)
const M_TO_NM = 0.000539956803

/** Project a geographic point to local nm (x = east, y = north) from REF. */
const project = ({ lat, lon }) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`non-finite geographic coordinate in OSM data: ${JSON.stringify({ lat, lon })}`)
  }
  const x = round((lon - REF.lon) * NM_PER_DEG_LON)
  const y = round((lat - REF.lat) * NM_PER_DEG_LAT)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`projection produced a non-finite point from ${JSON.stringify({ lat, lon })}`)
  }
  return [x, y]
}
const round = (n) => Math.round(n * 1e4) / 1e4

// aeroway values we keep, in draw order (background surfaces first).
const KEEP = new Set([
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

// OpenStreetMap tags the KBUR spine and its main connectors (A/B/C/D/G, A1–A3,
// B1–B3, C6–C8, D1–D2/D7–D8, G1, BB). ~29 unnamed ways touch the runways and need
// designators for hold-short / intersection-departure destinations — those are
// patched here by OSM way id, matched to the FAA airport diagram (00067AD.PDF),
// the way docs/SAN/taxiway-naming.md documents KSAN. Deferred to the taxiway-naming
// theme; left empty so this first ingest projects the raw surface as-is.
const REF_PATCH = {}

// Charted hot spots (not in OSM). KBUR publishes hot spots on SW3HOTSPOT.PDF;
// their exact centres are read off that chart during the naming theme.
const HOTSPOTS = []

let raw
try {
  raw = JSON.parse(readFileSync(RAW, 'utf8'))
} catch (err) {
  throw new Error(`failed to read/parse ${RAW}`, { cause: err })
}
if (!Array.isArray(raw?.elements)) {
  throw new Error(`${RAW}: expected an OSM response with an "elements" array (a rate-limited or error response?)`)
}

const features = []
const matchedRefPatch = new Set() // REF_PATCH ids actually seen in this snapshot
const skippedKept = [] // KEEP-listed elements dropped for want of usable geometry

for (const el of raw.elements) {
  const kind = el.tags?.aeroway
  if (!kind || !KEEP.has(kind)) continue

  let points
  if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 0) {
    points = el.geometry.map(project)
  } else if (el.type === 'node' && el.lat != null) {
    points = [project(el)]
  } else {
    // A KEEP-listed element with no usable geometry — e.g. an Overpass response
    // missing `out geom`, or a way truncated on re-fetch. Don't drop it silently:
    // a vanished taxiway/runway segment would break routing with no error.
    skippedKept.push(`${el.type}/${el.id} (${kind})`)
    continue
  }

  const feature = { kind, points }
  const patch = REF_PATCH[el.id]
  if (patch !== undefined) matchedRefPatch.add(String(el.id))
  // Use truthy-fallback (not ??): an empty-string OSM ref/name must not defeat REF_PATCH.
  const ref = el.tags.ref || el.tags.name || patch
  if (ref) feature.ref = ref
  if (el.tags.width) {
    const meters = parseFloat(el.tags.width)
    if (Number.isFinite(meters)) feature.widthNm = round(meters * M_TO_NM)
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 2 && first[0] === last[0] && first[1] === last[1]) {
    feature.closed = true
  }
  features.push(feature)
}

// Fail loudly rather than write partial/mislabeled data into the deterministic core.
if (skippedKept.length > 0) {
  throw new Error(
    `${skippedKept.length} kept aeroway element(s) had no usable geometry: ${skippedKept.join(', ')} — refusing to write a partial surface`,
  )
}
const unmatchedRefPatch = Object.keys(REF_PATCH).filter((id) => !matchedRefPatch.has(id))
if (unmatchedRefPatch.length > 0) {
  throw new Error(
    `REF_PATCH has ${unmatchedRefPatch.length} way id(s) not present in this OSM snapshot: ${unmatchedRefPatch.join(', ')} — the upstream ways changed; re-verify against docs/BUR/taxiway-naming.md`,
  )
}

// Bounds over everything except the (huge) aerodrome boundary polygon.
let minX = Infinity
let minY = Infinity
let maxX = -Infinity
let maxY = -Infinity
for (const f of features) {
  if (f.kind === 'aerodrome') continue
  for (const [x, y] of f.points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
}
for (const v of [minX, minY, maxX, maxY]) {
  if (!Number.isFinite(v)) {
    throw new Error(`computed bounds are not finite — no usable non-aerodrome features? ${JSON.stringify({ minX, minY, maxX, maxY })}`)
  }
}

const surface = {
  icao: 'KBUR',
  name: 'Hollywood Burbank (Bob Hope)',
  ref: REF,
  units: 'nm from ref; x=east, y=north',
  source: 'OpenStreetMap contributors (ODbL) via Overpass API',
  bounds: { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY) },
  features,
  hotspots: HOTSPOTS,
}

writeFileSync(OUT, JSON.stringify(surface) + '\n')

const counts = {}
for (const f of features) counts[f.kind] = (counts[f.kind] ?? 0) + 1
console.log('wrote', OUT)
console.log('features:', features.length, counts)
console.log('bounds nm:', surface.bounds)
