# Adding an airport

The engine holds no airport knowledge. It is handed a taxi graph, a runway guard, a runway
configuration and a spawn config, and simulates whatever it is given. Everything that makes a
field *that* field lives in one `Airport` bundle (`packages/sim/src/world/airport.ts`), and KSAN
is simply the first one (`world/ksanAirport.ts`).

`world/airport.test.ts` builds a fictional north–south field from scratch and plays a full
arrival and departure on it. If that test passes, the abstraction is real; if adding an airport
turns into a refactor, that test is where the leak will show up first.

---

## 1. The data you need

**Sources, exact commands and what each one does *not* carry:
[airport-data-pipeline.md](airport-data-pipeline.md).** Read it first — most of the mistakes in
`docs/SAN/` came from asking the wrong source.

| What | Where from |
|---|---|
| Surface geometry | OpenStreetMap via Overpass → `tools/ingest` |
| Displaced thresholds, declared distances, glide paths, EMAS | **FAA NASR** — on no chart |
| Which procedures exist | d-TPP metafile — never guess from filenames |
| Taxiway names, hot spots | FAA airport diagram |

`docs/SAN/runway-9-27.md` is the worked example of the write-up NASR should produce — copy its
shape before writing any code.

**Two risks worth checking before you commit to a field:**

1. **Gate nodes.** KSAN's stands came from tagged OSM gate nodes. Not every airport has them. No
   gate nodes means no spawning, and hand-authoring stands is real work.
2. **Taxiway naming.** KSAN needed **27 way-id patches** to name untagged OSM segments, matched
   by endpoint topology against the airport diagram. Could be zero, could be a day. Pull the
   Overpass extract and count unnamed ways touching the movement area before estimating.

## 2. Before you start: read the post-mortem

**[lessons-from-ksan.md](lessons-from-ksan.md)** lists twenty things that went wrong building the
first airport, each written as a check to run on the next one. Several shipped, two survived a
green test suite and were caught by review, and most of the geometry ones were invisible until
the code met real OSM data. It is the highest-value ten minutes in this folder.

## 3. The steps

0. **Read the post-mortem** above, and the pipeline doc.
1. **Ingest the surface.** Copy `tools/ingest/build-ksan-surface.mjs`, set the reference point
   (the airport reference point) and the Overpass query, run it, and check the validator passes.
   Patch untagged taxiway ways by id as needed, documenting the mapping the way
   `docs/SAN/taxiway-naming.md` does.
2. **Pull NASR** and write up the runway facts as a doc, as `docs/SAN/runway-9-27.md` does. Do
   this *before* coding — it is where the surprises are.
3. **Write the airport module**, mirroring `world/ksanAirport.ts`: runway configurations
   (thresholds, declared distances, glide paths, patterns), the painted layout, gates, servicing,
   comms, traffic tuning, and the airline/type mix.
4. **Point the app at it**: `createGroundController({ airport: YOUR_AIRPORT })`. Nothing else in
   the web layer needs touching — it reads the field off `controller.airport`.
5. **Copy `world/airport.test.ts`** for the new field and make it play.

## 4. Cross-check the derived geometry

The ingest is trustworthy but not infallible. Verify against the survey:

- runway endpoints within a few feet of the NASR positions (KSAN: **5 ft** and **2 ft**)
- derived true bearing against `TRUE_ALIGNMENT`
- the runway-exit table (`buildRunwayExits`) eyeballed against the airport diagram — angles,
  sides and rapid-vs-standard classification
- `buildRunwayIntersections` naming every connector the diagram shows

## 5. What is *not* ready: more than one runway

**The model assumes a single runway.** Adding a multi-runway field is not a data exercise. The
places that assume it, each flagged in the source:

- `buildRunwayGuard` builds from *every* runway feature, so `onRunway` cannot say *which*
- `nearestRunwayPoint` (line-up) projects onto the nearest segment of any runway
- `ActiveRunway` is one direction and `farRunwayEnd` gives one answer for the whole field
- **runway occupancy is field-wide** — `blocksRunway` means a departure on one runway blocks a
  landing on another

…plus wake separation, which tracks a single `lastDeparture` for the whole field.

The last is a model change rather than a refactor: occupancy has to become per-runway, and the
configuration becomes a *set* of active runways with dependencies between them.

**And there are two distinct flavours**, measured from NASR:

| | Shape | What it demands |
|---|---|---|
| **Intersecting** (e.g. KBUR) | 08/26 × 15/33 cross at 66% / 79% along | A time-and-position conflict model at the crossing; hold-short-of-the-intersecting-runway, timed departures between arrivals, LAHSO |
| **Parallel** (e.g. KOAK) | 10L/28R and 10R/28L are **1,001 ft** apart | Two runways active at once, and dependency rules — under the ~2,500 ft threshold they are not independent, so arrivals must be staggered |

Shared foundation ≈ 1 week; intersecting adds ~3–5 days; parallel adds ~5–8 days. Do an
intersecting two-runway field first: it forces the whole foundation and adds exactly one new rule.
KBUR and KOAK are carried as candidates in `backlog.md` with their measured geometry.

## 6. Rough effort

| | |
|---|---|
| Single-runway field, good OSM data | **1.5–2.5 days** |
| …with poor taxiway tagging | add up to a day of chart cross-referencing |
| …with no OSM gate nodes | add stand authoring |
| Multi-runway field | **+1–2 weeks** for the occupancy model first |
