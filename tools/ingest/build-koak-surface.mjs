// Transforms the raw KOAK OpenStreetMap aeroway snapshot into the sim's surface
// data file, projecting lat/lon onto a local tangent plane (nm east/north from
// the airport reference point). One-time ingestion — no runtime external calls.
//
//   Regenerate:  node tools/ingest/build-koak-surface.mjs
//   Re-fetch:    curl --data-urlencode "data@tools/ingest/koak.overpass.ql" \
//                  -H "User-Agent: AnotherATC" \
//                  https://overpass-api.de/api/interpreter -o tools/ingest/koak-osm.raw.json
//
// Source: OpenStreetMap contributors (ODbL). Overpass API.
//
// KOAK is the third field, and the project's first PARALLEL multi-runway case.
// See docs/OAK/README.md (chart index, cycle 2607) and docs/OAK/runways.md
// (surveyed NASR facts) for the authoritative data. What differs from KBUR:
//   - FOUR runways, ZERO intersections. The two close parallels 10L/28R and
//     10R/28L are 1,001 ft apart (measured, docs/OAK/runways.md §0) — well under
//     the ~2,500 ft independent-approach threshold, so they are DEPENDENT: the
//     `wake`/`landing` coupling, not KBUR's `occupancy` crossing.
//   - The big air-carrier runway 12/30 sits on the separate South Field ~1 nm
//     southwest; 30 has a displaced threshold (114 ft) and is the CAT II/III end.
//   Thresholds come from NASR, never the OSM way endpoints (docs/OAK/runways.md §2).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const RAW = join(here, 'koak-osm.raw.json')
const OUT = join(here, '..', '..', 'packages', 'sim', 'src', 'world', 'koak.surface.json')

// KOAK airport reference point (ARP) and field elevation, from NASR APT_BASE.csv.
const REF = { lat: 37.72126138, lon: -122.22115055, elevationFt: 9 }

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

// aeroway values we keep, in draw order (background surfaces first). Same KEEP set
// as KSAN/KBUR: helipad, jet_bridge, navigationaid and tower are dropped as
// non-movement clutter.
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

// Untagged OSM taxiway ways patched to their designator by way id, matched by
// endpoint topology against the FAA airport diagram (00294AD.PDF). Populated in
// the taxiway-naming theme (docs/OAK/taxiway-naming.md); empty here means the
// pipeline slice carries only the spine names OSM already provides. The ingest
// throws if a patch id is absent from the snapshot, so a stale id can't rot silently.
const REF_PATCH = {}

// Orphaned pavement removed from the surface — see docs/taxi-graph-audit.md. The taxi-graph audit
// found six disconnected islands, all unnamed `taxilane` (ramp/GA lanes, not through-taxiways) in
// the NE North Field, none reachable from the movement area and none with a stand attached (all 65
// gates reach the main network, which already connects them to every modelled runway). Per the
// "route to the gate, not via [unreachable] apron/ramp pavement" discipline (as at KBUR) they are
// dropped; when North Field GA ground ops are modelled the pavement returns with a real connection
// and its own stands. island-3's apron+hangar are background surfaces (not routed) and stay.
// Same matched-or-throw guard as REF_PATCH: a re-fetch that renames these ids fails loudly.
const DROP = new Set([
  1279273585, 1279273597, // island 1 (NE taxilane loop, ~0.41,0.47)
  1365797264, 1365797265, 1365797266, 1365797267, // island 2 (~0.26,0.69)
  1365797271, // island 3 taxilane (~0.18,0.89) — the apron/hangar there are background, kept
  1365797275, // island 4 (~-0.20,1.11)
  1372203798, // island 5 (~0.35,0.51)
  1372203799, // island 6 (~0.30,0.59)
])

// Charted hot spots (not in OSM). KOAK publishes hot spots on SW2HOTSPOT.PDF;
// their exact centres are read off that chart during the naming theme.
const HOTSPOTS = []

// Missing centreline connections — the lessons-from-ksan.md #27 data fix. Where two
// OSM ways that meet in reality were digitised with their endpoints a few dozen feet
// apart, the taxi graph keys nodes by exact coordinates and leaves the pieces
// disconnected. The node-merge in taxiGraph.ts folds gaps within ~30 ft; a genuine
// junction wider than that is welded here, as its own feature so no existing geometry
// moves. Populated after the first surface generation shows what is islanded.
const BRIDGES = []

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
const matchedDrop = new Set() // DROP ids actually seen in this snapshot
const skippedKept = [] // KEEP-listed elements dropped for want of usable geometry

for (const el of raw.elements) {
  const kind = el.tags?.aeroway
  if (!kind || !KEEP.has(kind)) continue

  // Deliberately dropped orphaned pavement (see DROP) — before any geometry work.
  if (DROP.has(el.id)) {
    matchedDrop.add(String(el.id))
    continue
  }

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

// Append the hand-authored bridges (see BRIDGES) as their own taxiway features. Each must land
// both endpoints on an existing node, so assert every bridge endpoint coincides with a projected
// vertex already in the surface — a bridge that connects nothing is a silent no-op otherwise.
const vertexKeys = new Set(features.flatMap((f) => f.points.map((p) => `${p[0]},${p[1]}`)))
for (const bridge of BRIDGES) {
  for (const p of bridge.points) {
    if (!vertexKeys.has(`${round(p[0])},${round(p[1])}`)) {
      throw new Error(
        `bridge endpoint [${p}] does not coincide with any existing surface vertex — it would connect nothing; re-check against the surface`,
      )
    }
  }
  features.push({ kind: 'taxiway', points: bridge.points.map((p) => [round(p[0]), round(p[1])]), ...(bridge.ref ? { ref: bridge.ref } : {}) })
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
    `REF_PATCH has ${unmatchedRefPatch.length} way id(s) not present in this OSM snapshot: ${unmatchedRefPatch.join(', ')} — the upstream ways changed; re-verify against docs/OAK/taxiway-naming.md`,
  )
}
const unmatchedDrop = [...DROP].filter((id) => !matchedDrop.has(String(id)))
if (unmatchedDrop.length > 0) {
  throw new Error(
    `DROP has ${unmatchedDrop.length} id(s) not present in this OSM snapshot: ${unmatchedDrop.join(', ')} — the upstream ways changed; re-verify against docs/taxi-graph-audit.md`,
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
  icao: 'KOAK',
  name: 'Oakland San Francisco Bay Intl',
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
