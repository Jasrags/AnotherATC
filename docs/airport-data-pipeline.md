# Airport data pipeline — where the numbers come from

Every airport fact in this project traces to one of four sources. This file records which source
answers which question, the exact commands, and — importantly — **what each source does not
carry**, because most of the mistakes in `docs/SAN/` came from asking the wrong source.

| Question | Source | Not this |
|---|---|---|
| Pavement geometry — runways, taxiways, aprons, stands | OpenStreetMap (Overpass) | Not the airport diagram (schematic) |
| Displaced thresholds, declared distances, glide paths, EMAS, surveyed positions | **NASR** | **Not on any chart** |
| Which procedures exist, and what they are | d-TPP metafile | Not the PDF filenames |
| Taxiway names, hot spots, layout sanity | FAA airport diagram | Not markings or pavement extents |

---

## 1. NASR — the one that matters most

The FAA's 28-day subscription. Structured CSV, surveyed, and it carries everything the charts
don't. **Pull this before modelling anything.**

Find the current edition, then take the small airport-only bundle (~8 MB, not the ~100 MB full
subscription):

```bash
curl -sS "https://external-api.faa.gov/apra/nfdc/nasr/chart?edition=current"
# → editionDate, e.g. 07/09/2026

curl -sS -o apt.zip \
  "https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip"
unzip -q apt.zip -d apt
```

Files that matter: `APT_RWY.csv` (dimensions, surface), `APT_RWY_END.csv` (the gold),
`APT_RMK.csv` (EMAS and other remarks), `APT_CON.csv` (frequencies), `APT_BASE.csv` (ARP).

### Fields to extract from `APT_RWY_END.csv`

| Field | Feeds |
|---|---|
| `RWY_END_ID`, `TRUE_ALIGNMENT` | runway ident, and a check on the ingest's derived bearing |
| `LAT_DECIMAL` / `LONG_DECIMAL` | physical pavement end — cross-check against OSM |
| `LAT_DISPLACED_THR_DECIMAL` / `LONG_DISPLACED_THR_DECIMAL`, `DISPLACED_THR_LEN` | **the landing threshold**, which is often not the end of the pavement |
| `TKOF_RUN_AVBL`, `TKOF_DIST_AVBL`, `ACLT_STOP_DIST_AVBL`, `LNDG_DIST_AVBL` | TORA / TODA / ASDA / **LDA** |
| `VISUAL_GLIDE_PATH_ANGLE`, `THR_CROSSING_HGT` | the approach profile, per end |
| `ILS_TYPE`, `APCH_LGT_SYSTEM_CODE`, `VGSI_CODE` | which end is precision — do **not** assume |
| `RIGHT_HAND_TRAFFIC_PAT_FLAG` | pattern direction |
| `RWY_END_PSN_SOURCE` | provenance; KSAN's reads `3RD PARTY SURVEY, 2020-10-16` |

Arresting systems are usually a **remark**, not a field. Grep `APT_RMK.csv` for `EMAS`, `ARREST`,
`DSPLCD`, `OVERRUN`. KSAN's reads:

> `EMAS ENGINEERED MATERIALS ARRESTING SYSTEM (EMAS) 315 FT IN LENGTH BY 218 FT IN WIDTH LCTD AT DER 27.`

**`DER 27` means the *departure* end of runway 27 — the west end.** Read these carefully; getting
it backwards puts a safety feature at the wrong end of the field.

### Converting to our local frame

```
NM_PER_DEG_LAT = 60
NM_PER_DEG_LON = 60 · cos(ref.lat)
x = (lon − ref.lon) · NM_PER_DEG_LON      # east
y = (lat − ref.lat) · NM_PER_DEG_LAT      # north
```

`ref` is the airport reference point used by `tools/ingest` — the same one, or nothing lines up.

---

## 2. d-TPP — which procedures exist

**Never infer a chart's type from its filename.** The KSAN index had ten departure procedures
filed as STARs and two ILS approaches filed as SIDs, because someone (me) guessed from the names.

The metafile is authoritative. Find the current cycle first — expired cycles are removed from the
server, so an old cycle number 404s:

```bash
curl -sS "https://external-api.faa.gov/apra/dtpp/chart"
# → editionNumber 7, editionDate 07/09/2026  ⇒ cycle "2607"

curl -sS -o meta.xml "https://aeronav.faa.gov/d-tpp/2607/xml_data/d-TPP_Metafile.xml"   # ~16 MB
```

Then pull the `<record>` entries under the airport's `<airport_name apt_ident="…">` and read
`chart_code` (`IAP` / `STR` / `DP` / `APD` / `MIN` / `HOT`) and `chart_name`. Individual charts:

```bash
curl -sS -o 00373AD.PDF "https://aeronav.faa.gov/d-tpp/2607/00373AD.PDF"
```

**Record the cycle in the folder's README**, and treat charts as perishable — `docs/SAN` sat on
an expired cycle for months without anything saying so.

---

## 3. OpenStreetMap — the pavement

Fetch with Overpass into `tools/ingest/<icao>-osm.raw.json`, then project with the ingest script.
The committed raw response is the reproducible input; the ingest makes no network calls.

```bash
curl --data-urlencode "data@tools/ingest/<icao>.overpass.ql" \
  https://overpass-api.de/api/interpreter -o tools/ingest/<icao>-osm.raw.json
```

**Quality varies enormously and is the main schedule risk.** Two things to count before
committing to a field:

1. **Untagged taxiway ways touching the movement area.** KSAN needed **27** patched by way id,
   matched by endpoint topology against the airport diagram (`docs/SAN/taxiway-naming.md`).
   Patches are keyed to upstream way ids, which change; the ingest throws if a patch id vanishes.
2. **Gate nodes with refs.** No gate nodes means no spawning. KSAN had them; not every field does.
3. **`aeroway=parking_position` ways — the painted stand lead-in lines.** These matter more than
   they look: a stand is modelled as a *line*, not a point (`ground/stands.ts`). Count them
   against the gate nodes. KSAN has them for all 32 Terminal 2 stands and **none** for Terminal
   1's 19, which is typical — coverage is often per-terminal, not per-field.

### What parking_position ways do *not* give you

Every one of these was learned by getting it wrong first:

- **A consistent direction.** At KSAN 28 run taxilane→stand and 4 run the other way. Which end
  is the stand has to be resolved per line, against the gate node — never assumed from the
  winding order.
- **A reliable match by position.** Adjacent stands sit closer together than a gate node sits
  from its own line, so nearest-endpoint matching picks a *neighbour's* line for roughly a third
  of the field: measured, only 19 of 32 agreed with the correct answer. **Match by designator.**
  Note the designators may be a different scheme from the gate nodes — KSAN's refs `1`–`5` and
  `11`–`14` are east-side and commuter stands, *not* an old Terminal 1 numbering, which is what
  they look like at first glance.
- **Where the nose stops, for a stand that has no line.** A gate node marks the stand *at the
  terminal*, roughly a plane's length in from the stop mark (median **28 m** at KSAN). Running a
  derived lead-in all the way to it parks the aircraft inside the building — five of KSAN's
  nineteen Terminal 1 stands did exactly that until the setback was measured from the field's
  own charted stands.

Missing lines are recoverable: `buildStands` derives a straight one off the nearest taxi pavement
and flags it `source: 'derived'`. A field with no `parking_position` coverage at all still works;
it just gets straight-in stands everywhere.

---

## 4. The airport diagram — layout, not measurements

Good for taxiway names, hot spots, and sanity-checking the network. It is **schematic**: it shows
no pavement markings, no blast pads, no chevrons, no EMAS extent, and no declared distances. Do
not try to read geometry off it — that is what NASR is for.

---

## 5. Verify the ingest against the survey

Always, before trusting derived geometry. For KSAN:

| Check | Result |
|---|---|
| OSM runway endpoints vs NASR surveyed ends | **5 ft** and **2 ft** |
| Derived true bearing vs `TRUE_ALIGNMENT` | 106.1° vs 106° |
| OSM polyline length vs published | 9,381 ft vs 9,401 ft |

If these don't agree, the reference point or the projection is wrong, and everything downstream
inherits it.

### Derived-geometry invariants worth asserting on a new field

These exist as tests for KSAN and are cheap to copy. Each one caught a real defect:

| Assert | Caught |
|---|---|
| every stand's nose stop is nearer a terminal polygon than its entry (`stands.test.ts`) | the 4 back-to-front lines, checked against geometry that didn't feed the rule |
| no derived stand's stop falls inside a terminal footprint | 5 aircraft parked inside Terminal 1 |
| every stand still routes to the runway (`turnRouting.test.ts`) | that the turn limit removed impossible turns without stranding anything |
| no gate→runway route contains a turn sharper than `MAX_TURN_DEG` | 8 near-reversals the router was planning through Terminal 1 |

The turn survey is worth running as a *histogram* on a new field before trusting the threshold —
see the routing section of [adding-an-airport.md](adding-an-airport.md).
