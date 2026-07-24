# Runway operations — state, designation, and configuration

**Status:** reference material. Sections 1–8 describe real-world runway state and how ATC assigns,
designates, and communicates it; §9 records where the sim is today and what the first slice is.
**Authorities:** FAA Order 7110.65 (ATC), AIM Ch. 4 (airport operations), and the runway-condition
matrix (RCAM, AC 150/5200-30 / TALPA). Cite the chapter and verify the paragraph against the
current edition before relying on it.

This is the companion to [`atc-multi-runway.md`](atc-multi-runway.md): that note is the *engine
seam* for two runways interacting; this one is the *state and designation* of a runway — what it is
for (departures, arrivals, or both), whether it is usable at all, and how a controller says so.

---

## 1. The basic states

**Closed.** Physically unavailable — construction, damage, FOD, snow removal, an emergency. Marked
with a large yellow **X** at each threshold, NOTAMed in advance when planned. ATC will not assign it
and pilots must not use it. *"Runway 27 is closed, NOTAMed until 1800 Zulu."*

**Inactive / not in use.** Physically open but not currently being used — no X, it looks normal. ATC
simply doesn't assign it ("out of the mix"), but it can become active quickly if wind or traffic
demand it, and an aircraft could still *request* it.

**Active.** Currently assigned for operations, carrying at least one **designation** (below).

## 2. Active runway designations

**Departure only.** Takeoffs exclusively. Chosen when the wind favours the departure heading, the
length suits takeoff performance, traffic flow wants arrivals and departures separated, or noise
routes dictate it. No landing clearance issues on it. *"Runway 9, cleared for takeoff."*

**Arrival only.** Landings exclusively. Chosen when the wind favours that direction, the precision
approach (ILS) is only on that end, traffic volume wants a dedicated arrival flow, or wake
management puts heavies on one runway and others elsewhere. No takeoff clearance issues on it.
*"Runway 27, cleared to land."*

**Mixed ops (dual use).** Both takeoffs and landings on the same runway. Common at single-runway
airports (KSAN — no choice), in lower-traffic periods at multi-runway fields, or when one runway is
closed. The most demanding single-runway operation: Tower must **sequence gaps** — can this
departure get out before the next arrival is too close; will this arrival clear before the next
departure needs the runway. Internally, "single runway mixed ops."

## 3. Runway configuration

At a multi-runway field, the combination in use is the **runway configuration** (or *complex*). It
changes on:

- **Wind** — the primary driver. Aircraft take off and land *into* the wind; the tailwind limit is
  typically **10 kt** for commercial aircraft. A significant wind shift triggers a **runway change**.
- **Traffic volume** — low: one runway, mixed; medium: one departure + one arrival runway; high:
  multiple arrival and departure runways with dedicated crossing routes.
- **Time of day** — many fields flip at night for noise abatement (e.g. LAX westbound "over the
  water" ops by day; KSAN predominantly lands 27 into the westerly sea breeze).
- **Noise abatement** — restricted ends at night, prohibited departure headings over residential
  areas, curfews on certain runway/direction combinations.

**Calm-wind runway.** Under ~5 kt (effectively calm), ATC designates a calm-wind runway — usually
the one that best serves noise abatement or traffic flow.

## 4. How ATC communicates runway state

**ATIS** (Automatic Terminal Information Service) — the recorded broadcast pilots get *before*
calling. It states the configuration outright, e.g. *"…Runways in use: runway 27 for arrivals,
runway 27 for departures. ILS runway 27 approach in use…"* and is stamped with a phonetic letter
("information Delta") the pilot must confirm on first contact.

**Runway-change announcement** — broadcast on all frequencies when the configuration changes
mid-session: *"Attention all aircraft, San Diego is now changing to runway 9 operations due to wind
shift. All departures runway 9, all arrivals runway 9. Acknowledge."* Every aircraft acknowledges.

**NOTAM** — for planned closures, reduced lengths, displaced-threshold or EMAS work; published in
advance and expected to be reviewed before flight.

## 5. Runway condition reporting

Beyond open/closed/active, the **surface condition** is reported.

**RCR / RCAM** — a runway condition code 0–6:

| Code | Condition |
|---|---|
| 6 | Dry |
| 5 | Frost / wet |
| 4 | Wet snow / slush |
| 3 | Dry snow / wet ice |
| 2 | Wet snow over compacted snow |
| 1 | Ice |
| 0 | Wet ice / water on compacted snow |

*"Runway 27 condition code 4, wet snow, braking action fair."*

**Braking-action reports** — pilots who just landed report back (*"Alaska 412, braking action good,
runway 27"*), and Tower relays to subsequent arrivals with the source and age (*"Caution, braking
action fair to poor on runway 27, reported by a 737 ten minutes ago"*).

## 6. Special runway states

- **Contaminated** — standing water, snow, ice, slush, rubber buildup; affects braking distance, may
  restrict types. Tower advises; the pilot makes the performance call.
- **Shortened / reduced length** — construction reduces usable length, NOTAMed as reduced TORA/LDA.
  *"Runway 27, full length not available, 8,000 feet available."*
- **ILS critical area active** — during low-visibility approaches, aircraft and vehicles hold outside
  the ILS critical area to protect the signal. *"Hold short of runway 27, ILS critical area in use."*
- **Hot** — informal: the runway is very active with tight sequencing. *"Expect no delay, runway is
  hot right now."*

## 7. The state hierarchy

```
CLOSED ──── NOTAMed, X-marked, no operations
  │
INACTIVE ── available but not in use, no X
  │
ACTIVE
  ├── DEPARTURE ONLY   — takeoff clearances only
  ├── ARRIVAL ONLY     — landing clearances only
  └── MIXED OPS        — both; Tower sequences the gaps
        ├── single runway (KSAN)
        └── same runway both directions (rare, calm-wind only)
```

## 8. How the designation changes phraseology

| State | Tower |
|---|---|
| Closed | "Runway 27 is closed" |
| Departure only | "Runway 9, cleared for takeoff" — no landing clearances |
| Arrival only | "Runway 27, cleared to land" — no takeoff clearances |
| Mixed ops | both clearance types; Tower manages the gaps |
| Runway change | "Attention all aircraft, changing to runway 9 operations" |
| Contaminated | "Caution, braking action reported poor, runway 27" |
| Shortened | "Runway 27, 8,000 feet available" |
| ILS critical | "Hold short, ILS critical area" |

---

## 9. Where the sim is today

The engine models an **active runway set** — at most one direction per physical runway
(`docs/atc-multi-runway.md` §5). Everything a runway can be, mapped to that:

| Concept (above) | Sim today |
|---|---|
| **Active — Mixed ops** | ✅ **The only designation.** The spawner picks intent (departure/arrival) 50/50 and then a runway from the active set at random (`trySpawn`), so *every active runway is mixed ops*, and both takeoff and landing clearances gate on it. Single-runway KSAN is exactly "single runway mixed ops". |
| **Active — Departure only** | ❌ Not expressible. Nothing designates a runway takeoffs-only, so a departure-only / arrival-only *split* across two active runways (the common multi-runway configuration) cannot be set. **This is the first slice — §9.1.** |
| **Active — Arrival only** | ❌ Not expressible (same as above). |
| **Inactive / not in use** | ➖ A runway not in the active set is effectively inactive (drawn normally, no X, unassigned). But there is no "an aircraft may still request it" path, and "off" is really "not in the mix" rather than a first-class state. |
| **Closed** | ❌ No distinct closed state — no X marking, no NOTAM, no "runway 27 is closed" broadcast. "Off" is the nearest thing but means *inactive*, not *closed*. |
| **Runway configuration change** | 🚧 Partial. `setRunway` / `deactivateRunway` change the config, and a change **cascades** correctly (committed traffic refused or, on a close, drained onto a remaining runway; arrivals on final go around and re-establish on the new approach; landing clearances void). But there is **no "attention all aircraft" broadcast** and no acknowledgement mechanic. |
| **ATIS config line** | ❌ The D-ATIS *frequency* is on the `Airport` bundle and shown in the header, but there is no spoken/derived ATIS stating the runways-in-use, and no information letter. |
| **Wind (the primary driver)** | ❌ No wind model at all, so runway selection is the controller's free choice rather than wind-driven; the tailwind limit, calm-wind runway, and wind-shift trigger do not exist. (Backlog: *Weather — wind (affects ops)*.) |
| **Condition reporting (RCR/RCAM, braking, contaminated)** | ❌ None. No surface condition, no braking-action reports, no contaminated/reduced-braking performance effects. |
| **Shortened / reduced length** | ➖ Declared distances (TORA/LDA) are modelled per direction and *used* (a takeoff is refused with insufficient runway), but there is no dynamic NOTAM'd length reduction. |
| **ILS critical area** | ❌ Not modelled; no low-visibility state and no critical-area hold. |
| **Hot** | ➖ Emergent, not named — tight sequencing happens under load but the game does not label a runway "hot". |

### 9.1 First slice — the operations designation (departure / arrival / mixed)

The one the game most wants, and the natural next step on the multi-runway foundation. Each **active
runway carries an operations designation**: `mixed` (today's behaviour, the default), `departures`,
or `arrivals`. It plugs into what already exists:

- **The `ActiveRunway` set** gains the designation (engine state, since it is a *rule about
  operations* — an aircraft may not land on a departures-only runway at any field). The web control
  extends from `dir → reciprocal → off` to also cycle the designation, or a second control sets it.
- **The spawner** respects it: a `departures`-only runway is never chosen for an arrival, an
  `arrivals`-only runway never for a departure. With one runway `departures` and another `arrivals`,
  traffic splits cleanly — the classic two-runway configuration.
- **The clearance gates** enforce it: `clearedToLand` is refused on a `departures` runway
  ("runway 9 is departures only"); `lineUpAndWait` / `clearedForTakeoff` refused on an `arrivals`
  runway. This mirrors the existing "not in use" refusal (`takeoffBlocked`) — a new, adjacent reason.
- **KOAK is the field that wants it**: the close parallels realistically run one for arrivals and one
  for departures, or both for arrivals staggered (the dependent-approach rule, a later slice). KBUR
  and KSAN stay mixed by default, so nothing regresses.

Deferred to later slices, each roughly independent: a true **closed** state (X marking + broadcast),
a **wind model** to *drive* selection and the calm-wind/tailwind rules, the **ATIS information
letter** and the **"attention all aircraft"** runway-change broadcast, and **surface-condition /
braking** reporting.

---

## Appendix — provenance

Sections 1–8 are supplied reference material, lightly reformatted to this repo's style: headings
normalised, the KSAN/BUR examples kept, and the content condensed without dropping substance. The
"where the sim is today" audit (§9) and the first-slice proposal (§9.1) are this repo's, written
against the code as it stands.
