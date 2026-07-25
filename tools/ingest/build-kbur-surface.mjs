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
// B1–B3, BB, C6–C8, D1–D2/D7–D8, G1). Of the ~29 unnamed ways that touch a runway,
// 19 are continuation segments of an already-named taxiway (they share a node with
// it and reach the runway edge) — patched here by OSM way id, matched by endpoint
// topology and cross-referenced to the FAA airport diagram (00067AD.PDF). Method and
// per-way rationale: docs/BUR/taxiway-naming.md. The remaining 10 are deliberately
// left unnamed (run-up/bypass-apron fillets at the 15 threshold, the C/D crossing
// throats, the SE terminal-apron cluster, and the two runway-end stubs) — same
// discipline as KSAN: you route to the gate, not via apron pavement.
const REF_PATCH = {
  // 15/33 — NE-side connectors (A-series) and SW-side connectors (B-series),
  // each extended to the runway edge / hold line.
  99871903: 'A2',
  221228113: 'A3',
  221228199: 'A3',
  99872086: 'B2',
  221227905: 'B3',
  221228208: 'B3',
  99872054: 'C', // C reaching 15/33 just past the crossing (81% along)

  // 08/26 — the C and D parallels and their numbered connectors, extended to the
  // runway edge. C6/C7/C8 and D7/D8 are the connectors; A and B are the 15/33
  // parallels reaching 08/26 either side of the crossing.
  99872003: 'C6',
  99872004: 'C6',
  99872034: 'C7',
  99872002: 'C8',
  558772698: 'D7',
  558772691: 'D8',
  99872009: 'C', // C's west end reaching the 08 threshold
  99872011: 'D', // D's west end reaching the 08 threshold
  99871973: 'B', // B reaching 08/26 just west of the crossing
  99871976: 'B',
  221231878: 'A', // A reaching 08/26 just east of the crossing
  221231956: 'A',
}

// Orphaned pavement removed from the surface — see docs/BUR/taxiway-naming.md and
// docs/taxi-graph-audit.md. The SE terminal-apron cluster is four unnamed taxiway ways forming a
// self-contained loop NE of the 08/26 × 15/33 crossing; it touches nothing in the movement area and
// no stand attaches to it (all 14 gates reach the network elsewhere). It is BUR's GA / remote-
// parking apron, not yet modelled as gates (see kburAirport.ts). The taxi-graph audit flagged it as
// an 8-node disconnected island; per the "route to the gate, not via apron pavement" discipline
// (same as KSAN) it is dropped rather than bridged — when GA traffic is modelled it returns with a
// real connection and stands. The two holding_position markers sitting on the cluster go with it;
// the third nearby marker (node 8028996414, on taxiway C) is on the network and stays.
// Same matched-or-throw guard as REF_PATCH: a re-fetch that renames these ids fails loudly.
// The two fillet triangles once dropped here by way-id (the taxiway-B triangle near [-0.087, 0.436]
// and the taxiway-D triangle near [-0.36, -0.09]) are now collapsed generically by the
// redundant-second-fillet pass in taxiGraph.ts, along with the equivalents at KSAN and KOAK — so no
// per-field drop is needed for them (docs/taxi-graph-audit.md).
const DROP = new Set([
  99871959, 99871960, 99871982, 99871991, // the four apron-loop taxiway ways
  1154611488, 8028996387, // the two holding_position markers on that apron
])

// Charted hot spots (not in OSM). KBUR publishes hot spots on SW3HOTSPOT.PDF;
// their exact centres are read off that chart during the naming theme.
const HOTSPOTS = []

// Missing centreline connections — the lessons-from-ksan.md #27 data fix. Where two OSM ways
// that meet in reality were digitised with their endpoints a few dozen feet apart, the taxi
// graph keys nodes by exact coordinates and leaves two disconnected nodes, severing whatever is
// beyond. The node-merge in taxiGraph.ts folds gaps within ~30 ft, but both KSAN and KBUR have
// genuinely-distinct junctions ~31–32 ft apart, so the threshold cannot be widened without
// welding real pavement — the fix belongs in the field data instead.
//
// Each bridge is a short taxiway between two points that ARE already graph nodes (endpoints of
// existing ways), added as its own feature so no existing geometry moves. Coordinates are the
// ingest-rounded local-nm values; a bridge whose endpoints do not both land on a node connects
// nothing, so verify against the surface after regenerating.
const BRIDGES = [
  {
    // The SE passenger terminal (gates A1–A9, B1–B5) reaches the movement area only through a
    // stub that ends on runway 08/26 at the 26 threshold, 34 ft from where taxiway D ends on the
    // same pavement — OSM split that junction in two. Without this the whole terminal is an
    // island: no arrival can taxi in and no departure can taxi out. Links the stub end to D's end.
    ref: 'D',
    points: [
      [0.4195, -0.1825], // stub end (terminal side)
      [0.4251, -0.1825], // taxiway D end (main network)
    ],
  },
]

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

  // Deliberately dropped orphaned pavement (see DROP) — before any geometry work, so a dropped
  // way can never reach the surface or the skipped-geometry guard.
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
    `REF_PATCH has ${unmatchedRefPatch.length} way id(s) not present in this OSM snapshot: ${unmatchedRefPatch.join(', ')} — the upstream ways changed; re-verify against docs/BUR/taxiway-naming.md`,
  )
}
const unmatchedDrop = [...DROP].filter((id) => !matchedDrop.has(String(id)))
if (unmatchedDrop.length > 0) {
  throw new Error(
    `DROP has ${unmatchedDrop.length} id(s) not present in this OSM snapshot: ${unmatchedDrop.join(', ')} — the upstream ways changed; re-verify against docs/BUR/taxiway-naming.md`,
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
