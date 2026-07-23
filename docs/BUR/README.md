# BUR (Hollywood Burbank / Bob Hope) — FAA charts & data pipeline

KBUR is the project's **second airport** and the first **multi-runway** field — the *intersecting*
case (08/26 × 15/33). Sourcing follows `docs/airport-data-pipeline.md`; the process is
`docs/adding-an-airport.md`; do not skip `docs/lessons-from-ksan.md`.

Source: FAA d-TPP. Chart classifications below are taken from the **d-TPP metafile**
(`https://aeronav.faa.gov/d-tpp/2607/xml_data/d-TPP_Metafile.xml`), not from filenames — the KSAN
folder got a third of them wrong by guessing from names.

> **Cycle.** All charts here are cycle **2607, effective 09 JUL – 06 AUG 2026** — current at the
> time of writing, and the same cycle as the KSAN NASR data. Chart prefix is `00067`. Charts are
> perishable: the FAA removes expired cycles from the server. Refresh from
> `https://aeronav.faa.gov/d-tpp/2607/<file>` (bump the cycle) before relying on any chart detail.

## What's in this folder

| File | Chart |
|------|-------|
| `00067AD.PDF` | Airport Diagram (APD) — taxiway layout, hold lines, gates |
| `SW3LAHSO.PDF` | LAHSO (land-and-hold-short) distances — the intersecting-runway data |
| `SW3HOTSPOT.PDF` | Hot Spot (SW-3 regional) |
| `runways.md` | **Authoritative surveyed runway facts from NASR — read before any runway geometry** |

The STAR / SID / approach plates below are catalogued (for the eventual TRACON phase) but not
downloaded yet — they are one `curl` each from `https://aeronav.faa.gov/d-tpp/2607/<file>`.

## Full d-TPP record set for KBUR (metafile, 28 records)

**Airport diagram / info:** `00067AD.PDF` (APD) · `SW3LAHSO.PDF` (LAHSO) · `SW3HOTSPOT.PDF` (HOT) ·
`SW3TO.PDF` (takeoff mins + DVA) · `SW3ALT.PDF` (alternate mins). The SW-3 files are regional, not
BUR-specific.

**Approaches (IAP) — every instrument approach is to RWY 08:**

| File | Chart |
|------|-------|
| `00067IYLY8.PDF` | ILS Y or LOC Y RWY 08 |
| `00067IZLZ8.PDF` | ILS Z or LOC Z RWY 08 |
| `00067RRY8.PDF` | RNAV (RNP) Y RWY 08 |
| `00067RZ8.PDF` | RNAV (GPS) Z RWY 08 |
| `00067V8.PDF` | VOR RWY 08 |
| `00067FOURSTACKS_VIS15.PDF` | Four Stacks Visual RWY 15 |

**08 is the precision end.** There is **no published instrument approach to 26, 15, or 33** — 15
has only the Four Stacks Visual; 26 and 33 have none. This mirrors the KSAN asymmetry (one
precision end) and drives which direction is the "landing" configuration.

**STARs (arrivals):** FERNANDO SEVEN (`00067FERNANDO.PDF` + `_C`) · JANNY FIVE RNAV
(`00067JANNY.PDF`) · LYNXX EIGHT (`00067LYNXX.PDF`) · ROKKR THREE RNAV (`00067ROKKR.PDF` + `_C`) ·
THRNE FOUR RNAV (`00067THRNE.PDF` + `_C`) · WEESL ONE RNAV (`00067WEESL.PDF`).

**SIDs / DPs (departures):** ELMOO NINE (`00067ELMOO.PDF`) · OROSZ TWO RNAV (`00067OROSZ.PDF`) ·
SLAPP TWO RNAV (`00067SLAPP.PDF` + `_C`) · VAN NUYS FOUR (`00067VANNUYS.PDF` + `_C`) · VVERA TWO
RNAV (`00067VVERA.PDF`).

## Not charts, but needed: runway data

Declared distances, displaced thresholds and EMAS are **not on the airport diagram** and not in
d-TPP. They come from the FAA NASR 28-day subscription (cycle 2607, effective 2026-07-09):

```
https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip   (~8 MB)
  APT_BASE.csv · APT_RWY.csv · APT_RWY_END.csv · APT_RMK.csv
```

Everything extracted — both displaced 15/33 thresholds, the EMAS at DER 08, per-end glide paths
and approach aids, the runway crossing point, and the surveyed positions in our local frame — is
written up in **[runways.md](runways.md)**. Read that before touching runway geometry.

## Surface data (OpenStreetMap)

Ingest inputs are committed under `tools/ingest/`: the Overpass query (`kbur.overpass.ql`), the
raw snapshot (`kbur-osm.raw.json`), and the projector (`build-kbur-surface.mjs`) which writes
`packages/sim/src/world/kbur.surface.json`. No runtime network calls; regenerate deterministically
with `node tools/ingest/build-kbur-surface.mjs`.

### Surface-quality scan (the pre-commit go/no-go per `adding-an-airport.md`)

Counted against the committed OSM extract:

| Signal | KBUR | Read |
|---|---|---|
| Gate nodes (spawning) | **14** (A1–A9, B1–B5) | good |
| `parking_position` lead-in lines | **14** — one per gate | **full coverage**, better than KSAN |
| Taxiway ways | 115 (20 named, 95 unnamed) | spines named; most unnamed are apron/fillet |
| Unnamed taxiways **touching a runway** | **~29** | the real naming workload (KSAN patched 18–27) |
| `construction` features | **44** (`construction=parking_position`) | new Burbank replacement terminal — excluded by the ingest KEEP set, but the OSM surface is mid-redevelopment and will churn |
| Field span | 1.48 × 1.14 nm | compact, KSAN-comparable |

**Verdict: GO.** Full gate + stand coverage means spawning and real paint work out of the box. The
one labour item is naming the ~29 runway-touching connectors against `00067AD.PDF` (by OSM way id,
the way `docs/SAN/taxiway-naming.md` does for KSAN) — a `docs/BUR/taxiway-naming.md` to be written
in the naming theme. The first ingest ships with an empty patch set, so those connectors are
currently unnamed.

## Game relevance

- **Airport diagram** (`00067AD.PDF`) — validates the taxiway network; source for the connector
  naming. Schematic: no pavement markings, blast pads, chevrons or EMAS extent.
- **LAHSO** (`SW3LAHSO.PDF`) — the land-and-hold-short distances to the intersection; the
  intersecting-runway mechanic's optional extension.
- **NASR runway data** — the real geometry and the crossing point (see `runways.md`).
- **STARs / SIDs / approaches** — future TRACON routing; note the asymmetry: **08 is the only
  precision end**, so the landing configuration is built around it.
