# KOAK Runways 10L/28R, 10R/28L, 12/30, 15/33 — authoritative reference

**Sources**
- FAA NASR 28-day subscription, effective **2026-07-09** (cycle 2607) — `APT_RWY.csv`,
  `APT_RWY_END.csv`, `APT_RMK.csv`, `APT_BASE.csv`
  (`https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip`)
- FAA Airport Diagram `00294AD.PDF` and Hot Spot `SW2HOTSPOT.PDF` (this folder)

Runway positions in NASR are marked `3RD PARTY SURVEY, 2020/08/31` — surveyed data, not
charting. It is the source of truth for anything in this file, ahead of both the airport diagram
(schematic) and OpenStreetMap.

**Airport reference point (ARP):** `37.72126138, -122.22115055`, field elevation **9 ft**.
This is the reference used by `tools/ingest/build-koak-surface.mjs`; every local-nm coordinate
below is measured from it (x = east, y = north).

---

## 0. Why KOAK — parallel runways, and two of them are dependent

KOAK is the project's **third** field and the first **parallel** multi-runway case (KBUR was the
*intersecting* case). **Four runways, zero intersections** — the opposite geometry problem from
KBUR. Two of them, the close parallels, are the reason the field was chosen:

| | 10L/28R | 10R/28L | 12/30 | 15/33 |
|---|---|---|---|---|
| Dimensions | **5,457 × 150 ft** | **6,213 × 150 ft** | **10,520 × 150 ft** | **3,376 × 75 ft** |
| True alignment | 112° / 292° | 112° / 292° | 130° / 310° | 164° / 344° |
| Field | North | North | **South** | North |
| ILS end(s) | **28R** | none | **12 and 30** | none |
| Surface | ASPH | ASPH | ASPH | ASPH |

**The close parallels.** `10L/28R` and `10R/28L` are physically parallel and only **1,001 ft
apart** (measured centreline-to-centreline from the surveyed thresholds, below). That is well
under the **~2,500 ft** threshold for independent parallel approaches, so the two runways are
**not independent**: arrivals to one constrain arrivals to the other, and a wake corridor is
shared. This is the whole mechanic — the *dependent-parallel* coupling, contrasted with KBUR's
*occupancy* crossing. See `docs/atc-multi-runway.md` §6 for the seam it plugs into.

**Measured separations** (perpendicular distance between centrelines, from the surveyed ends):

| Pair | Separation | Read |
|---|---|---|
| 10L/28R ↔ 10R/28L | **1,001 ft** | dependent — well under 2,500 ft |
| 12/30 ↔ 10R/28L | ~5,400–6,400 ft | independent; a physically separate field |

**The two fields.** `12/30` sits on the **South Field**, roughly a nautical mile southwest of the
North Field parallels, with its own terminal apron. `10L/28R`, `10R/28L` and `15/33` are the
**North Field** (historically the GA/reliever complex). A KOAK ground picture spans two physically
separate movement areas — a scope/flow consideration KSAN and KBUR did not have.

**No LAHSO, no runway intersections.** Because nothing crosses, there is no hold-short-of-the-
intersecting-runway rule to build (that was KBUR). The new rule is entirely about **separation
between the parallels**.

---

## 1. Runway 10L/28R — the shorter North parallel, ILS on 28R

| | RWY 10L (NW end) | RWY 28R (SE end) |
|---|---|---|
| True alignment | 112° | 292° |
| **Displaced threshold** | **none** | **none** |
| Threshold crossing height | 50 ft | 51 ft |
| Glide path angle | **3.0°** | **3.0°** |
| Traffic pattern | left | **right** |
| VGSI | PAPI 4R | PAPI 4L |
| Approach lights | none | **MALSR** |
| Navaid | none (RNAV GPS RWY 10L) | **ILS** (ILS or LOC RWY 28R) |

**28R is the precision end** of this pair — the only ILS among the four North-Field runway ends —
with MALSR and PAPI, standard 3.0°, and a **right-hand** pattern. **10L is a bare end**: RNAV only,
no VGSI approach lights, left traffic.

### Declared distances (10L/28R)

| | RWY 10L | RWY 28R |
|---|---|---|
| TORA | 5,457 | 5,457 |
| TODA | 5,457 | 5,457 |
| ASDA | 5,336 | 5,457 |
| **LDA** | **5,336** | **5,457** |

10L's LDA is **121 ft short of its TORA with no displaced threshold** — a declared-distance
reduction (safety-area limited at the far end), not a displacement. Carry the 5,336 as the LDA;
the landing threshold is still the pavement end.

## 2. Runway 10R/28L — the longer North parallel, EMAS at the 28L departure end

| | RWY 10R (NW end) | RWY 28L (SE end) |
|---|---|---|
| True alignment | 112° | 292° |
| **Displaced threshold** | **none** | **none** |
| Threshold crossing height | 50 ft | 50 ft |
| Glide path angle | 3.0° | 3.0° |
| Traffic pattern | left | left |
| VGSI | PAPI 4L | PAPI 4R |
| Approach lights | none | none |
| Navaid | VOR / RNAV GPS RWY 10R | RNAV (RNP) Z RWY 28L |

Neither end has an ILS; all distances are the full **6,213 ft** both ways, no displacements.

### EMAS — one bed, at the west (28L departure) end

> `ENGINEERED MATERIALS ARRESTING SYSTEM (EMAS) 162 FT IN LENGTH BY 154 FT IN WIDTH LCTD AT THE
> DER 28L.`

**DER 28L = the departure end of runway 28L.** RWY 28L heads 292° (WNW), so a departure or a
landing rollout on 28L travels *west* and overruns westward — the departure end is the **west end
of 10R/28L, at the 10R threshold side**. The bed arrests westbound overruns: a landing on 28L or a
rejected takeoff on 28L. It is 162 × 154 ft. EMAS is passive — no ATC action, and aircraft must
never be taxied onto it.

## 3. Runway 12/30 — the South-Field air-carrier runway, CAT II/III on 30

| | RWY 12 (NW end) | RWY 30 (SE end) |
|---|---|---|
| True alignment | 130° | 310° |
| **Displaced threshold** | **none** | **114 ft** |
| Threshold crossing height | 70 ft | 71 ft |
| Glide path angle | 2.75° | **3.0°** |
| Traffic pattern | **right** | left |
| VGSI | PAPI 4R | PAPI 4L |
| Approach lights | **MALSR** | **ALSF-2** |
| Navaid | **ILS** (ILS or LOC RWY 12) | **ILS/DME** (ILS or LOC RWY 30, CAT II–III) |

The long runway, and the primary air-carrier runway. **Both ends have an ILS** — 12 with MALSR
(2.75° path), and **30 is the CAT II/III end**: ILS/DME, **ALSF-2** approach lights, 3.0°, with a
**114 ft displaced threshold**. 30 is the landing configuration for low-visibility operations.

### Declared distances (12/30)

| | RWY 12 | RWY 30 |
|---|---|---|
| TORA | 10,000 | 10,000 |
| TODA | 10,000 | 10,000 |
| ASDA | 10,000 | 10,000 |
| **LDA** | **10,000** | **10,000** |

The **physical pavement is 10,520 ft** but the declared distances are 10,000 both ways — there is a
**400 × 220 ft blast pad at each of RWY 12 and RWY 30** (NASR remark), not usable pavement. On 30
the LDA is measured from the displaced threshold.

## 4. Runway 15/33 — the short North-Field crosswind, no instrument approach

| | RWY 15 (N end) | RWY 33 (S end) |
|---|---|---|
| True alignment | 164° | 344° |
| **Displaced threshold** | none | none |
| Traffic pattern | left | **right** |
| VGSI / lights / navaid | none | none |

The short GA crosswind runway, **3,376 × 75 ft** — the only 75-ft-wide runway at the field. No
instrument approach, no VGSI, no declared-distance reductions (LDA = the physical 3,376 ft both
ways). A light-aircraft runway; not part of the air-carrier flow.

## 5. Geometry in our local frame

Local nm from the ARP (`37.72126138, -122.22115055`; x = east, y = north):

| Point | lat, lon | local (nm) |
|---|---|---|
| RWY 10L threshold = physical end (NW) | 37.73046922, -122.22218005 | `[-0.0489, 0.5525]` |
| RWY 28R threshold = physical end (SE) | 37.72481455, -122.20470872 | `[0.7803, 0.2132]` |
| RWY 10R threshold = physical end (NW) | 37.72870822, -122.22590241 | `[-0.2255, 0.4468]` |
| RWY 28L threshold = physical end (SE) | 37.72227386, -122.20600930 | `[0.7186, 0.0607]` |
| RWY 12 threshold = physical end (NW) | 37.72006261, -122.24211511 | `[-0.9950, -0.0719]` |
| RWY 30 physical end (SE) | 37.70149319, -122.21425797 | `[0.3271, -1.1861]` |
| **RWY 30 threshold** (displaced 114 ft) | 37.70169436, -122.21455986 | `[0.3128, -1.1740]` |
| RWY 15 threshold = physical end (N) | 37.74029261, -122.22280947 | `[-0.0787, 1.1419]` |
| RWY 33 threshold = physical end (S) | 37.73136275, -122.21967391 | `[0.0701, 0.6061]` |

### Our ingested geometry is accurate

| Check | Result |
|---|---|
| OSM 10L / 28R ends vs FAA surveyed | **4 ft** / **40 ft** |
| OSM 10R / 28L ends vs FAA surveyed | **7 ft** / **7 ft** |
| OSM 12 / 30 ends vs FAA surveyed | **2 ft** / **6 ft** |
| OSM 15 / 33 ends vs FAA surveyed | **6 ft** / **4 ft** |
| Reconstructed lengths vs published | 5,444 / 6,198 / 10,505 / 3,379 ft (pub 5,457 / 6,213 / 10,520 / 3,376) |
| Derived true bearings | 112.3° / 112.2° / 130.1° / 164.5° (FAA 112 / 112 / 130 / 164) |

So OpenStreetMap can be trusted for all four runways. The 28R endpoint is the loosest at 40 ft
(still inside a runway half-width); the sim uses the NASR thresholds regardless — the OSM geometry
is what is *drawn*.

---

## 6. What this means for the sim

1. **Two parallels, 1,001 ft apart, dependent.** This is the reason KOAK exists as a field.
   Occupancy, wake and the active set are already per-runway behind the `runwayIdAt` /
   `runwaysInteract` seam (`docs/atc-multi-runway.md`). KOAK adds the **dependent-parallel** rule:
   a `wake`/`landing` coupling of `10L/28R` ↔ `10R/28L` (NOT `occupancy` — nothing crosses), with
   **no crossing point**, so it stays the coarse coupling rather than KBUR's position-aware one.
   Simultaneous arrivals to the two runways must be staggered.
2. **28R is the precision end of the parallels** — the only ILS among the four North ends, MALSR,
   PAPI, right traffic. The North-Field landing configuration is built around it.
3. **12/30 is a separate field.** The air-carrier runway, ~1 nm southwest with its own terminal
   apron; **30 is CAT II/III** (ALSF-2, ILS/DME, 114 ft displaced threshold). A KOAK scope spans
   two physically separate movement areas.
4. **Declared distances that are not the pavement**: 10L LDA 5,336 (declared reduction, no
   displacement); 12/30 declared 10,000 on 10,520 ft of pavement (400 × 220 ft blast pad each
   end); 30 displaced 114 ft. Carry and use the declared numbers.
5. **EMAS beyond the west (28L departure) end of 10R/28L**, 162 × 154 ft — not landable, nothing
   taxis onto it.
6. **Traffic patterns are mixed**: right on 28R, 12, 33; left on 10L, 10R, 28L, 30, 15.
7. **15/33 is the light-aircraft crosswind** — 75 ft wide, no instrument approach, not in the
   air-carrier flow.

Radio frequencies (Tower/Ground/Clearance/ATIS) are **not** in the NASR airport bundle
(`APT_CON.csv` carries only administrative contacts, and OAK's is empty). Source them from the
airport diagram / published data when the comms bundle for KOAK is authored.
