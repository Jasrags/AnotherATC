# OAK (Oakland San Francisco Bay Intl) — FAA charts & data pipeline

KOAK is the project's **third airport** and the first **parallel** multi-runway field — the
*dependent-parallel* case (10L/28R and 10R/28L, 1,001 ft apart). KBUR was the *intersecting*
case. Sourcing follows `docs/airport-data-pipeline.md`; the process is `docs/adding-an-airport.md`;
do not skip `docs/lessons-from-ksan.md`.

Source: FAA d-TPP. Chart classifications below are taken from the **d-TPP metafile**
(`https://aeronav.faa.gov/d-tpp/2607/xml_data/d-TPP_Metafile.xml`), not from filenames — the KSAN
folder got a third of them wrong by guessing from names.

> **Cycle.** All charts here are cycle **2607, effective 09 JUL – 06 AUG 2026** — current at the
> time of writing, and the same cycle as the KSAN/KBUR data. Chart prefix is `00294`. Charts are
> perishable: the FAA removes expired cycles from the server. Refresh from
> `https://aeronav.faa.gov/d-tpp/2607/<file>` (bump the cycle) before relying on any chart detail.

## What's in this folder

| File | Chart |
|------|-------|
| `00294AD.PDF` | Airport Diagram (APD) — taxiway layout, hold lines, gates, the two fields |
| `SW2HOTSPOT.PDF` | Hot Spot (SW-2 regional) |
| `runways.md` | **Authoritative surveyed runway facts from NASR — read before any runway geometry** |

The STAR / SID / approach plates below are catalogued (for the eventual TRACON phase) but not
downloaded yet — they are one `curl` each from `https://aeronav.faa.gov/d-tpp/2607/<file>`.

## d-TPP record set for KOAK (metafile, cycle 2607)

**Airport diagram / info:** `00294AD.PDF` (APD) · `SW2HOTSPOT.PDF` (HOT) · `SW2TO.PDF`
(takeoff mins + DVA) · `SW2ALT.PDF` (alternate mins). The SW-2 files are regional, not OAK-specific.

**Approaches (IAP) — note the ILS asymmetry:**

| File | Chart |
|------|-------|
| `00294IL12.PDF` | ILS or LOC RWY 12 |
| `00294IL28R.PDF` | ILS or LOC RWY 28R |
| `00294IL30.PDF` | ILS or LOC RWY 30 |
| `00294I30C2_3.PDF` | ILS RWY 30 (CAT II–III) |
| `00294I12SAC1.PDF` / `00294I30SAC1.PDF` | ILS RWY 12 / 30 (SA CAT I) |
| `00294RRZ12/28L/28R/30.PDF` | RNAV (RNP) Z RWY 12 / 28L / 28R / 30 |
| `00294R10L.PDF` / `00294R10R.PDF` | RNAV (GPS) RWY 10L / 10R |
| `00294RY12/28L/28R/30.PDF` | RNAV (GPS) Y RWY 12 / 28L / 28R / 30 |
| `00294V10R.PDF` | VOR RWY 10R |

**ILS ends are 28R, 12, and 30 only** (30 is CAT II–III). **10L, 10R, 28L have no ILS** — RNAV/VOR
only. On the close parallels, **28R is the sole precision end**, which drives the North-Field
landing configuration; 12/30's low-visibility configuration lands **30** (ALSF-2, CAT II–III).

**STARs (arrivals):** AANET ONE RNAV (`00294AANET.PDF`) · EMZOH FOUR RNAV (`00294EMZOH.PDF` + `_C`)
· OAKES THREE RNAV (`00294OAKES.PDF` + `_C`) · PANOCHE SIX (`00294PANOCHE.PDF`) · PIRAT THREE RNAV
(`00375PIRAT.PDF`) · WNDSR TWO RNAV (`00294WNDSR.PDF`).

**SIDs / DPs (departures):** CNDEL FIVE RNAV · COAST NINE (+`_C`) · HUSSH TWO RNAV · KATFH THREE
RNAV · NIMITZ SIX · NUEVO EIGHT (+`_C`) · OAKLAND SIX (+`_C`) · QUAKE TWO · SALAD FIVE · SILENT
THREE (+`_C`) · SKYLINE ONE (+`_C`) · SUNNE ONE. (All `00294<name>.PDF`.)

## Not charts, but needed: runway data

Declared distances, displaced thresholds and EMAS are **not on the airport diagram** and not in
d-TPP. They come from the FAA NASR 28-day subscription (cycle 2607, effective 2026-07-09):

```
https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip   (~8 MB)
  APT_BASE.csv · APT_RWY.csv · APT_RWY_END.csv · APT_RMK.csv
```

Everything extracted — the 114 ft displaced threshold on 30, the EMAS at DER 28L, per-end glide
paths and approach aids, the **1,001 ft parallel separation**, and the surveyed positions in our
local frame — is written up in **[runways.md](runways.md)**. Read that before touching runway
geometry.

## Surface data (OpenStreetMap)

Ingest inputs are committed under `tools/ingest/`: the Overpass query (`koak.overpass.ql`), the
raw snapshot (`koak-osm.raw.json`), and the projector (`build-koak-surface.mjs`) which writes
`packages/sim/src/world/koak.surface.json`. No runtime network calls; regenerate deterministically
with `node tools/ingest/build-koak-surface.mjs`.

### Surface-quality scan (the pre-commit go/no-go per `adding-an-airport.md`)

Counted against the committed OSM extract:

| Signal | KOAK | Read |
|---|---|---|
| Gate nodes (spawning) | **29** (terminal gates 1–32) | good — spawning works out of the box |
| `parking_position` lead-in lines | **285** (88 with a ref) | heavy GA + terminal coverage |
| Taxiway ways | 114 (40 named, 74 unnamed) | spines named; most unnamed are apron/fillet |
| Unnamed taxiways **touching a runway** | **~26** | the real naming workload (KSAN 18–27, KBUR 29) |
| `construction` features | **0** | stable surface, unlike KBUR's terminal rebuild |
| Field span | 1.94 × 2.42 nm | **large** — two separate fields (North + South) |

**Verdict: GO.** Full gate + stand coverage means spawning and real paint work out of the box, and
the ~26 runway-touching unnamed ways are the KSAN-comparable naming theme (next). The field is
noticeably larger than KSAN/KBUR because it spans two physically separate movement areas.

Runway-endpoint verification against the NASR survey is in [runways.md](runways.md) §5 (2–7 ft on
every end but 28R at 40 ft, all inside a runway half-width).

## Game relevance

- **Airport diagram** (`00294AD.PDF`) — validates the taxiway network; source for the connector
  naming. Schematic: no pavement markings, blast pads, chevrons or EMAS extent.
- **NASR runway data** — the real geometry, the 1,001 ft parallel separation, the 30 displaced
  threshold and the EMAS (see `runways.md`).
- **STARs / SIDs / approaches** — future TRACON routing; note the asymmetry: **28R is the only
  precision end of the close parallels**, and **30 is the CAT II/III end** of 12/30.
