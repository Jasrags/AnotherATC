# SAN (San Diego International) — FAA Charts

Source: FAA d-TPP. Chart classifications below are taken from the FAA d-TPP metafile
(`https://aeronav.faa.gov/d-tpp/<cycle>/xml_data/d-TPP_Metafile.xml`), not from the filenames —
an earlier version of this file guessed from filenames and got a third of them wrong.

> **⚠️ Cycle status.** The PDFs here are from **SW-3, 19 MAR – 16 APR 2026, which has expired**;
> the FAA no longer serves that cycle. The current cycle at the time of writing is **2607,
> effective 09 JUL – 06 AUG 2026**. `SW3HOTSPOT.PDF` was fetched from 2607, so this folder
> currently mixes cycles. Refresh the whole set from
> `https://aeronav.faa.gov/d-tpp/2607/<file>` before relying on any chart detail.

## Airport Diagram / Hot Spots

| File | Chart |
|------|-------|
| 00373AD.PDF | Airport Diagram |
| SW3HOTSPOT.PDF | Hot Spot (SW-3 regional) |

## STARs (arrivals)

| File | Chart |
|------|-------|
| 00373BARET.PDF | BARET FIVE |
| 00373BARET_C.PDF | BARET FIVE, CONT.1 |
| 00373COMIX.PDF | COMIX TWO (RNAV) |
| 00373HUBRD.PDF | HUBRD ONE |
| 00373LUCKI.PDF | LUCKI ONE (RNAV) |
| 00373PLYYA.PDF | PLYYA TWO (RNAV) |
| 00373SHAMU.PDF | SHAMU ONE |
| 00373TOPGN.PDF | TOPGN TWO (RNAV) |

## SIDs / DPs (departures)

| File | Chart |
|------|-------|
| 00373BORDER.PDF | BORDER SEVEN |
| 00373CLSSY.PDF | CLSSY THREE (RNAV) |
| 00373CWARD.PDF | CWARD TWO (RNAV) |
| 00373ECHHO.PDF | ECHHO TWO (RNAV) |
| 00373FALCC.PDF | FALCC ONE |
| 00373MMOTO.PDF | MMOTO TWO (RNAV) |
| 00373PADRZ.PDF | PADRZ TWO (RNAV) |
| 00373PEBLE.PDF | PEBLE SIX |
| 00373SAYOW.PDF | SAYOW TWO (RNAV) |
| 00373ZZOOO.PDF | ZZOOO FOUR (RNAV) |

## Approach Procedures

| File | Chart |
|------|-------|
| 00373IYLY9.PDF | ILS Y or LOC Y RWY 09 |
| 00373IZLZ9.PDF | ILS Z or LOC Z RWY 09 |
| 00373R9.PDF | RNAV (GPS) RWY 09 |
| 00373L27.PDF | LOC RWY 27 |
| 00373RRZ27.PDF | RNAV (RNP) Z RWY 27 |
| 00373RY27.PDF | RNAV (GPS) Y RWY 27 |
| 00373SWEETWATER_VIS27.PDF | Sweetwater Visual RWY 27 |

## Takeoff Minimums / Alternate Minimums

| File | Chart |
|------|-------|
| SW3TO.PDF | Takeoff Minimums + Diverse Vector Area (SW-3 region) |
| SW3ALT.PDF | Alternate Minimums (SW-3 region) |

## Coverage

**We have every chart the FAA publishes for KSAN.** Verified against the d-TPP metafile: 29
records, all present locally.

Charts previously listed here as "to acquire" that **do not exist**:

| Previously listed | Reality |
|---|---|
| ILS RWY 27 | **SAN has no ILS to RWY 27.** 27 is localizer-only (LOC/DME, 3.5° path). The ILS is on **RWY 09** — see `00373IYLY9.PDF` / `00373IZLZ9.PDF`. |
| Harbor Visual RWY 27 | Not published in d-TPP. The only charted visual is the **Sweetwater Visual RWY 27**, which we have. |
| Point Loma Visual RWY 27 | Not published in d-TPP. |
| VOR RWY 27 | Not published — no VOR approach to 27 in the current cycle. |
| RNAV (GPS) RWY 9 | **Already here** — `00373R9.PDF` (it was mislabelled as "ILS Y or LOC Y RWY 9"). |
| Additional SIDs | **Already here** — all 10 DPs were present but filed under "STARs". |

## Not charts, but needed: runway data

Declared distances, displaced thresholds and EMAS are **not on the airport diagram** and not in
d-TPP. They come from the FAA NASR 28-day subscription:

```
https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_APT_CSV.zip   (~8 MB)
  APT_RWY.csv · APT_RWY_END.csv · APT_RMK.csv
```

Everything extracted for runway 09/27 — declared distances, both displaced thresholds, EMAS,
approach aids, and the surveyed threshold coordinates converted into our local frame — is written
up in **[runway-9-27.md](runway-9-27.md)**. Read that before touching runway geometry.

---

## Notes

- Hot spot **HS1** is marked on the airport diagram (orange circle) near the general aviation
  parking / taxiway C–B intersection — elevated runway incursion risk area. There *is* also a
  separate regional hot spot chart (`SW3HOTSPOT.PDF`); an earlier note here said there wasn't.
- Takeoff/alternate minimums and the hot spot chart are regional SW-3 documents covering the
  whole area, not SAN-specific.

## Game Relevance

- **Airport diagram** — taxiway layout, gate positions, hold-short lines; validates our taxiway
  network. Schematic: it does *not* show pavement markings, blast pads, chevrons or EMAS extent.
- **NASR runway data** — the real geometry (see `runway-9-27.md`).
- **STARs** define arrival routes and fixes — validate nav fix positions, add missing waypoints.
- **SIDs/DPs** define departure routes — future departure routing.
- **Approach plates** give the final approach course, altitudes and fixes. Note the asymmetry:
  RWY 09 is the precision (ILS) end; RWY 27 is localizer-only with a steep 3.5° path.
