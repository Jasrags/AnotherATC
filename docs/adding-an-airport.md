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

| What | Where from | Notes |
|---|---|---|
| Surface geometry | OpenStreetMap via Overpass → `tools/ingest` | Runways, taxiways, aprons, terminals, **gate nodes with refs** |
| Runway geometry & declared distances | FAA NASR 28-day subscription | `APT_RWY.csv`, `APT_RWY_END.csv`, `APT_RMK.csv` — see below |
| Taxiway names | The FAA airport diagram | To validate, and to patch what OSM has left untagged |
| Frequencies | Chart Supplement or NASR `APT_CON.csv` | Ground / Tower / ATIS |

NASR is the one that matters most, and it is not on any chart:

```
https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip   (~8 MB)
```

It carries displaced thresholds, TORA/TODA/ASDA/LDA, glide path angles, traffic pattern
direction, arresting systems (EMAS) and surveyed threshold coordinates. `docs/SAN/runway-9-27.md`
is the worked example — copy its shape.

**Two risks worth checking before you commit to a field:**

1. **Gate nodes.** KSAN's stands came from tagged OSM gate nodes. Not every airport has them. No
   gate nodes means no spawning, and hand-authoring stands is real work.
2. **Taxiway naming.** KSAN needed **27 way-id patches** to name untagged OSM segments, matched
   by endpoint topology against the airport diagram. Could be zero, could be a day. Pull the
   Overpass extract and count unnamed ways touching the movement area before estimating.

## 2. The steps

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

## 3. Cross-check the derived geometry

The ingest is trustworthy but not infallible. Verify against the survey:

- runway endpoints within a few feet of the NASR positions (KSAN: **5 ft** and **2 ft**)
- derived true bearing against `TRUE_ALIGNMENT`
- the runway-exit table (`buildRunwayExits`) eyeballed against the airport diagram — angles,
  sides and rapid-vs-standard classification
- `buildRunwayIntersections` naming every connector the diagram shows

## 4. What is *not* ready: more than one runway

**The model assumes a single runway.** Adding a multi-runway field is not a data exercise. The
places that assume it, each flagged in the source:

- `buildRunwayGuard` builds from *every* runway feature, so `onRunway` cannot say *which*
- `nearestRunwayPoint` (line-up) projects onto the nearest segment of any runway
- `ActiveRunway` is one direction and `farRunwayEnd` gives one answer for the whole field
- **runway occupancy is field-wide** — `blocksRunway` means a departure on one runway blocks a
  landing on another

The last is a model change rather than a refactor: occupancy has to become per-runway, and the
configuration becomes a *set* of active runways with dependencies between them (intersecting
runways, LAHSO, simultaneous approaches). Budget one to two weeks, not two days, and expect it
to churn predicates that much of the Tower test suite leans on.

## 5. Rough effort

| | |
|---|---|
| Single-runway field, good OSM data | **1.5–2.5 days** |
| …with poor taxiway tagging | add up to a day of chart cross-referencing |
| …with no OSM gate nodes | add stand authoring |
| Multi-runway field | **+1–2 weeks** for the occupancy model first |
