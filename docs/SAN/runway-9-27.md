# KSAN Runway 09/27 — authoritative reference

**Sources**
- FAA NASR 28-day subscription, effective **2026-07-09** — `APT_RWY.csv`, `APT_RWY_END.csv`,
  `APT_RMK.csv` (`https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip`)
- FAA Airport Diagram `00373AD.PDF` (this folder)

Runway positions in NASR are marked `3RD PARTY SURVEY, 2020-10-16` — this is surveyed data, not
charting. It is the source of truth for anything in this file, ahead of both the airport diagram
(which is schematic) and OpenStreetMap.

---

## 1. The runway

| | |
|---|---|
| Designation | 09/27 |
| Dimensions | **9,401 × 200 ft** |
| Surface | ASPH-CONC, excellent |
| True alignment | **106° / 286°** (the diagram's 095.0°/275.0° are *magnetic*) |
| Markings | PIR (precision instrument) both ends |

**Single runway.** There is no second runway at KSAN, so only one aircraft may occupy it and
arrivals and departures must use the *same* direction at any given time.

## 2. Both ends are displaced

This is the headline: **RWY 09 and RWY 27 both have displaced thresholds**, and 27's is large.

| | RWY 09 (west end) | RWY 27 (east end) |
|---|---|---|
| Displaced threshold | **1,000 ft** | **1,810 ft** |
| Threshold crossing height | 76 ft | 66 ft |
| Glide path angle | **3.3°** | **3.5°** (steep) |
| TDZ elevation | 16.7 ft | 16.8 ft |
| Physical end elevation | 13.9 ft | 16.4 ft |
| Traffic pattern | left | **right** |
| VGSI | PAPI 4L | PAPI 4R |
| Approach lights | MALSR | MALS |

## 3. Declared distances

| | RWY 09 | RWY 27 |
|---|---|---|
| TORA (takeoff run available) | 8,280 | **9,401** |
| TODA (takeoff distance available) | 9,401 | 9,401 |
| ASDA (accelerate-stop distance available) | 8,280 | 9,401 |
| **LDA (landing distance available)** | **7,280** | **7,591** |

Note RWY 09's TORA is 1,121 ft short of the physical length — a departure on 09 does *not* get
the whole runway, while a departure on 27 does. LDA is ~1.8–2.1 kft less than TORA on both ends,
which is exactly the pre-threshold pavement: usable for the takeoff run and for landing rollout,
never for touchdown.

## 4. EMAS

> `E60-27_EMAS`: *ENGINEERED MATERIALS ARRESTING SYSTEM (EMAS) 315 FT IN LENGTH BY 218 FT IN
> WIDTH LCTD AT DER 27.*

**DER 27 = the departure end of runway 27 = the WEST end.** So the EMAS bed sits beyond the west
end of the pavement, arresting aircraft that overrun while rolling *westward* — i.e. landing on
27 or rejecting a takeoff on 27. It is 315 × 218 ft. This matches the airport diagram, which
labels EMAS at the west end next to taxiway B10 and the ELEV 14 marker.

EMAS is passive: no ATC action, and aircraft must never be taxied onto it.

## 5. Geometry in our local frame

Local nm from the airport reference point used by `tools/ingest` (`32.7336, -117.1897`;
x = east, y = north):

| Point | lat, lon | local (nm) |
|---|---|---|
| RWY 09 physical end (west) | 32.73712241, -117.20435644 | `[-0.7397, 0.2113]` |
| **RWY 09 threshold** (displaced 1,000 ft) | 32.73636513, -117.20123011 | `[-0.5819, 0.1659]` |
| RWY 27 physical end (east) | 32.73000150, -117.17497163 | `[0.7434, -0.2159]` |
| **RWY 27 threshold** (displaced 1,810 ft) | 32.73137330, -117.18062966 | `[0.4578, -0.1336]` |

### Our ingested geometry is accurate

| Check | Result |
|---|---|
| OSM west end vs FAA surveyed west end | **5 ft** apart |
| OSM east end vs FAA surveyed east end | **2 ft** apart |
| OSM polyline end-to-end | 9,381 ft (published 9,401) |
| Derived true bearing west→east | 106.1° (FAA: 106°) |

So the OpenStreetMap surface can be trusted for the runway, and the two runway *thresholds* are
the values above rather than the polyline endpoints. The separately-tagged 686 ft way at the west
end is **not** the displaced portion (the 09 displacement is 1,000 ft) — it is just an OSM way
split, and carries no meaning for us.

## 6. Approach aids — the ILS is on 09, not 27

| | RWY 09 | RWY 27 |
|---|---|---|
| Navaid | **ILS/DME** | **LOC/DME** (localizer only) |
| Published approaches | ILS Y / LOC Y RWY 09, ILS Z / LOC Z RWY 09, RNAV (GPS) RWY 09 | LOC RWY 27, RNAV (RNP) Z RWY 27, RNAV (GPS) Y RWY 27, Sweetwater Visual RWY 27 |

RWY 27 has **no ILS** — it is localizer-only with a steep 3.5° path, which is why the approach
over the city is flown the way it is. Earlier notes in this repo (and a common assumption) had
this the other way round.

---

## 7. What this means for the sim

1. **Threshold ≠ pavement end.** `runwayEnds` currently derives both from the polyline endpoints
   and uses that one pair for the takeoff far end, the line-up point, the landing threshold, exit
   distances, and the midpoint rule. Landings must start at the *displaced* threshold; takeoff
   rolls start at the physical end (27) or 1,121 ft in (09).
2. **Runway exits should be measured from the landing threshold**, and the "past the midpoint"
   rule should use the LDA midpoint, not the pavement midpoint.
3. **One runway direction at a time.** Arrivals and departures must share a configuration.
4. **Per-end approach geometry**: 3.3° to 09, 3.5° to 27 — not a single hard-coded angle.
5. **EMAS and the pre-threshold pavement are not landable**, and nothing may taxi onto EMAS.
