// Transforms the raw KSAN OpenStreetMap aeroway snapshot into the sim's surface
// data file, projecting lat/lon onto a local tangent plane (nm east/north from
// the airport reference point). One-time ingestion — no runtime external calls.
//
//   Regenerate:  node tools/ingest/build-ksan-surface.mjs
//   Re-fetch:    curl --data-urlencode "data@tools/ingest/ksan.overpass.ql" \
//                  -H "User-Agent: AnotherATC" \
//                  https://overpass-api.de/api/interpreter -o tools/ingest/ksan-osm.raw.json
//
// Source: OpenStreetMap contributors (ODbL). Overpass API.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const RAW = join(here, 'ksan-osm.raw.json')
const OUT = join(here, '..', '..', 'packages', 'sim', 'src', 'world', 'ksan.surface.json')

// KSAN airport reference point (ARP) and field elevation.
const REF = { lat: 32.7336, lon: -117.1897, elevationFt: 17 }

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

// OpenStreetMap has no designators for KSAN's taxiway A and its A1–A7 exits, so
// we assign them by OSM way id (stable), matched to the FAA airport diagram:
// taxiway A is the south parallel; A1 is the east (RWY 27) end, A7 the west.
const REF_PATCH = {
  1509583620: 'A', // long south parallel spine
  1509583618: 'A7', // west connector
  1509583626: 'A6',
  1509583622: 'A5',
  1128125683: 'A4',
  1509583636: 'A3',
  1509583634: 'A2',
  1509583633: 'A1', // east connector (RWY 27 end)
  625964914: 'North Ramp', // unnamed north-central apron on the chart

  // Connector-segment completions: untagged OSM taxiway ways that continue a
  // numbered connector, matched by endpoint topology and cross-referenced to the
  // airport diagram (docs/SAN/taxiway-naming.md). Terminal-apron ways and the
  // ambiguous junction fillets are deliberately left unnamed.
  275612613: 'B1',
  485854353: 'B10',
  485854355: 'B10',
  485854356: 'B10',
  485854358: 'B9',
  485854363: 'B9',
  485854364: 'B9',
  485854369: 'B8',
  517076827: 'C2',
  1128125772: 'C4',
  1128125775: 'C4',
  1509583621: 'A5',
  1509583627: 'A6',
  1509583631: 'A1',
  1509583632: 'A1',
  1509583637: 'A3',
  1509583638: 'A3',
  1509583639: 'A2',
}

// Charted hot spots (not in OSM). HS1 sits by the GA parking / taxiway H area.
const HOTSPOTS = [{ id: 'HS1', label: 'HS 1', point: [0.507, -0.02], radiusNm: 0.05 }]

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
    `REF_PATCH has ${unmatchedRefPatch.length} way id(s) not present in this OSM snapshot: ${unmatchedRefPatch.join(', ')} — the upstream ways changed; re-verify against docs/SAN/taxiway-naming.md`,
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
  icao: 'KSAN',
  name: 'San Diego International (Lindbergh Field)',
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
