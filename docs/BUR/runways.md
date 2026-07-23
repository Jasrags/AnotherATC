# KBUR Runways 08/26 and 15/33 — authoritative reference

**Sources**
- FAA NASR 28-day subscription, effective **2026-07-09** (cycle 2607) — `APT_RWY.csv`,
  `APT_RWY_END.csv`, `APT_RMK.csv`, `APT_BASE.csv`
  (`https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip`)
- FAA Airport Diagram `00067AD.PDF` and LAHSO `SW3LAHSO.PDF` (this folder)

Runway positions in NASR are marked `3RD PARTY SURVEY, 2017/08/06` — surveyed data, not
charting. It is the source of truth for anything in this file, ahead of both the airport diagram
(schematic) and OpenStreetMap.

**Airport reference point (ARP):** `34.20069444, -118.35866666`, field elevation **778 ft**.
This is the reference used by `tools/ingest/build-kbur-surface.mjs`; every local-nm coordinate
below is measured from it (x = east, y = north).

---

## 0. Why KBUR — two runways that intersect

KBUR is the project's first multi-runway field, chosen as the **intersecting** case (KOAK is the
parallel case). The two runways cross, and *where* they cross is the whole mechanic:

| | 08/26 | 15/33 |
|---|---|---|
| Dimensions | **5,802 × 150 ft** | **6,886 × 150 ft** |
| True alignment | **091° / 271°** | **167° / 347°** |
| Surface | ASPH-CONC, excellent, grooved | ASPH-CONC, excellent, grooved |
| Edge lights | HIGH | MED |

**The crossing** (derived from the surveyed ends, and it matches the measured figure the backlog
carried): the centrelines intersect at local `[0.1111, -0.1773]`, which is

- **66.3 % along 08→26** — 3,835 ft from the 08 (west) threshold, 1,951 ft from the 26 (east) threshold
- **79.2 % along 15→33** — 5,462 ft from the 15 (NW) physical end, 1,434 ft from the 33 (SE) physical end

Both fractions are **past the midpoint** of the primary operating direction. That is the key
consequence for the sim: a full-length 08 departure reaches the crossing 3,835 ft into its roll,
so it is already fast there; and an intersection departure that holds short *of the crossing*
naturally uses the hold-short-of-an-intersecting-runway rule rather than the threshold hold we
already have. See `docs/atc-multi-runway.md` for the seam this plugs into.

**LAHSO.** KBUR publishes land-and-hold-short data (`SW3LAHSO.PDF`, a regional SW-3 chart). The
available landing distances to the intersection are on that chart, *not* in NASR. LAHSO is
optional for the first cut of the mechanic; the distances are read off that PDF when it is built.

---

## 1. Runway 08/26 — the ILS runway, no displaced thresholds

| | RWY 08 (west end) | RWY 26 (east end) |
|---|---|---|
| True alignment | 091° | 271° |
| **Displaced threshold** | **none** | **none** |
| Threshold crossing height | 61 ft | — |
| Glide path angle | **3.0°** | — (no VGSI) |
| TDZ elevation | 727.4 ft | 716.3 ft |
| Traffic pattern | **right** | left |
| VGSI | PAPI 4L | none |
| Approach lights | **MALSR** | none |
| Navaid | **ILS** (ILS Y/Z or LOC Y/Z RWY 08) | none |

**08 is the precision end** — the only ILS at the field, MALSR, PAPI, a standard 3.0° path — and,
unusually, it has **no displaced threshold**, so the landing threshold *is* the pavement end.
**26 is a bare end**: no instrument approach, no VGSI, no approach lights, standard left traffic.

### Declared distances (08/26)

| | RWY 08 | RWY 26 |
|---|---|---|
| TORA | 5,801 | 5,801 |
| TODA | 5,801 | 5,801 |
| ASDA | 5,801 | 5,801 |
| **LDA** | **5,801** | **5,801** |

All four distances are the full runway both ways (the 5,801 vs the 5,802 dimension is rounding).
Nothing is withheld on 08/26 — contrast 15/33 and KSAN, where displacements reduce the LDA.

## 2. Runway 15/33 — both ends displaced, obstacle-constrained approaches

| | RWY 15 (NW end) | RWY 33 (SE end) |
|---|---|---|
| True alignment | 167° | 347° |
| **Displaced threshold** | **909 ft** | **350 ft** |
| Threshold crossing height | 35 ft | 62 ft |
| Glide path angle | 3.25° | 3.2° |
| TDZ elevation | 767.9 ft | 735.8 ft |
| Traffic pattern | **right** | left |
| VGSI | PAPI 4L | PAPI 4L |
| Approach lights | none | none |
| Navaid | none (Four Stacks Visual RWY 15) | none |

Both 15/33 thresholds are displaced, and both approaches are **obstacle-constrained** — which is
*why* they are displaced. NASR remarks: `APCH RATIO 36:1 TO DSPLCD THR` on 15 and `22:1 TO DSPLCD
THR` on 33. Neither end has an instrument approach; 15 has the *Four Stacks Visual*.

### Declared distances (15/33)

| | RWY 15 | RWY 33 |
|---|---|---|
| TORA | 6,885 | 6,885 |
| TODA | 6,885 | 6,885 |
| ASDA | 6,885 | 6,885 |
| **LDA** | **5,976** (6,885 − 909) | **6,535** (6,885 − 350) |

The displaced pavement is usable for the takeoff run and rollout, never for touchdown — the LDA
reductions are exactly the two displacements.

## 3. EMAS — one bed, at the east end of 08/26

> `E60-08_EMAS`: *ENGINEERED MATERIAL ARRESTING SYSTEM (EMAS) 170 FT LENGTH BY 350 FT WIDTH LCTD
> AT THE DER 08.*

**DER 08 = the departure end of runway 08 = the EAST end** (RWY 08 heads 091°, so a departure or
landing rollout on 08 travels *east* and overruns eastward). The bed therefore sits **beyond the
east end of 08/26 — past the 26 threshold** — arresting eastbound overruns: a landing on 08 or a
rejected takeoff on 08. It is 170 × 350 ft. (Same DER convention as KSAN, whose EMAS is at DER 27
= its west end — read these carefully, backwards puts the safety feature at the wrong end.)

EMAS is passive: no ATC action, and aircraft must never be taxied onto it. There is no EMAS on
15/33.

## 4. Geometry in our local frame

Local nm from the ARP (`34.20069444, -118.35866666`; x = east, y = north):

| Point | lat, lon | local (nm) |
|---|---|---|
| RWY 08 threshold = physical end (W) | 34.19791094, -118.36914291 | `[-0.5199, -0.1670]` |
| RWY 26 threshold = physical end (E) | 34.19765038, -118.34995991 | `[0.4321, -0.1826]` |
| RWY 15 physical end (NW) | 34.21234466, -118.36046072 | `[-0.0890, 0.6990]` |
| **RWY 15 threshold** (displaced 909 ft) | 34.20990972, -118.35978900 | `[-0.0557, 0.5529]` |
| RWY 33 physical end (SE) | 34.19390519, -118.35537013 | `[0.1636, -0.4074]` |
| **RWY 33 threshold** (displaced 350 ft) | 34.19484272, -118.35562888 | `[0.1507, -0.3511]` |
| **Runway crossing** (08/26 × 15/33) | — | `[0.1111, -0.1773]` |

### Our ingested geometry is accurate

| Check | Result |
|---|---|
| OSM 08 (west) end vs FAA surveyed end | **1 ft** apart |
| OSM 26 (east) end vs FAA surveyed end | **11 ft** apart |
| Derived true bearing 08→26 | 270.9° (FAA: 271°) |
| OSM 15/33 reconstructed length (all 3 ways) | ~6,902 ft (published 6,886) |
| OSM 15 / 33 ends vs FAA surveyed (via the displaced-segment ways) | **1 ft** / **7 ft** |

So OpenStreetMap can be trusted for both runways. **But 15/33 is split into three OSM ways** —
a main centre segment plus a **909 ft** side piece at the 15 end and a **354 ft** side piece at
the 33 end. Those side pieces are the displaced-threshold portions (matching NASR's 909 ft / 350
ft), so the two 15/33 *thresholds* are the displaced values above, **not** the main-way endpoints.
08/26 is a single clean OSM way and its thresholds are its endpoints (no displacement).

---

## 5. What this means for the sim

1. **Two runways, and they interact.** This is the reason KBUR exists as a field. Occupancy, wake
   and the active set are already per-runway behind the `runwayIdAt` / `runwaysInteract` seam
   (`docs/atc-multi-runway.md`); KBUR adds the **crossing** rule — a time-and-position conflict at
   `[0.1111, -0.1773]`, hold-short-of-the-intersecting-runway, and timed departures between
   arrivals. LAHSO (`SW3LAHSO.PDF`) is the optional extension.
2. **The crossing is past both midpoints** (66 % / 79 %), so an intersection departure holding
   short of it reuses the existing hold-short machinery and the aircraft crossing it is already at
   speed. Model the conflict, not just the pavement.
3. **08 is the only precision end.** ILS, MALSR, PAPI, 3.0° — and **no displaced threshold**, so
   on 08/26 the landing threshold equals the pavement end. Do not copy KSAN's assume-displaced default here.
4. **15/33 both displaced** (909 ft / 350 ft) with obstacle-limited approaches; carry and *use*
   the LDA numbers (5,976 / 6,535), which do not reduce to two points on the pavement.
5. **Per-end approach geometry**: 3.0° to 08, 3.25° to 15, 3.2° to 33; 26 has no VGSI.
6. **Traffic patterns are mixed**: right traffic on 08 and 15, left on 26 and 33.
7. **EMAS beyond the east end of 08/26** (past the 26 threshold), 170 × 350 ft — not landable,
   nothing taxis onto it.

Radio frequencies (Tower/Ground/Clearance/ATIS) are **not** in the NASR airport bundle — `APT_CON.csv`
carries only administrative contacts. Source them from the airport diagram / published data when the
comms bundle for KBUR is authored.
