# Ground and Tower — division of responsibility

**Status:** reference material, being gathered. Sections 1–4 describe the real split; §5 records
where the sim currently diverges from it.
**Authorities:** FAA Order 7110.65 Ch. 3 (Airport Traffic Control); AIM Ch. 4 §3.
See also `docs/atc-flight-strips.md` §"Controller Mode Details" (the same two positions, summarized
at the level the flight strip needs), `docs/atc-flight-cycle.md` (the same handoffs as a *sequence*
rather than an ownership map), `docs/atc-runway-crossing.md`, `docs/atc-tower.md`.

The question this note answers is **who owns what**, which is a different cut through the same
material as the flight cycle. Where the two disagree, this note is the one about authority.

---

## 1. Ground Control

Ground owns everything moving on the airport surface that is **not on an active runway** — its
domain is the **movement area**.

**Aircraft movement**
- Pushback and engine-start clearances (at many airports)
- Taxi routing gate → runway hold-short line
- Taxi routing runway exit → gate after landing
- Sequencing aircraft to the runway in the right order
- Runway crossing clearances (at many airports — sometimes delegated to Tower)

**Vehicle / equipment movement**
- All ground vehicles in the movement area — fuel trucks, baggage tugs, maintenance
- Coordinates vehicle crossings of taxiways
- Instructs vehicle operators exactly as it instructs aircraft

**Conflict prevention**
- Preventing taxiway incursions
- Managing hot spots (known high-risk intersections)
- Sequencing to avoid taxiway gridlock
- Ensuring nothing enters a runway without clearance

**Frequency management**
- Hands off to Tower at the runway hold-short line
- Receives from Tower after runway exit
- At some airports, coordinates with Ramp Control for gate areas

**Ground does not control:** anything on an active runway · airborne aircraft · gate areas at
major airports (Ramp/Apron Control).

## 2. Tower Control (Local Control)

Tower owns the **active runway surfaces** and the airspace immediately around the airport —
typically to about 5 miles and 2,500–3,000 ft AGL, depending on the Class B/C/D designation.

**Departures**
- Takeoff clearances; line up and wait
- Initial heading / altitude after departure
- Hands off to Departure Control (TRACON) once airborne

**Arrivals**
- Receives from Approach Control (TRACON)
- Landing clearances
- Monitors runway occupancy — the runway must be clear before the next aircraft is cleared to land
- Go-around instructions
- Tells pilots which taxiway to exit on
- Hands off to Ground after the runway exit

**Runway management**
- Authorizes **all** runway entry — departures, crossings, touch-and-goes
- Manages runway occupancy time
- Sequences departures between arrivals (the "gap" judgment)
- Wake turbulence warnings and separation
- Low approach and touch-and-go clearances for training traffic

**Visual separation**
- At towered fields, Tower may apply visual rather than radar separation
- *"Traffic to follow is a 737 on a 5 mile final, report in sight"*

**Emergency authority**
- Declares a ground stop
- Overrides normal sequence for emergencies
- Coordinates with ARFF (Aircraft Rescue and Fire Fighting) for gear-up landings, fuel
  emergencies, and the like

**Tower does not control:** taxiways (Ground) · airspace beyond its delegated area
(TRACON/Center) · gate areas.

## 3. The handoff chain

The same chain as `docs/atc-flight-cycle.md`, drawn as ownership rather than sequence:

```
GATE
  ↓
RAMP CONTROL (at major airports)
  ↓  [aircraft reaches ramp/apron boundary]
GROUND CONTROL
  ↓  [aircraft reaches runway hold short line]
TOWER CONTROL
  ↓  [aircraft airborne, ~½ to 5 miles out]
DEPARTURE CONTROL (TRACON)
  ↓
CENTER (ARTCC)

——— and in reverse for arrivals ———

CENTER
  ↓
APPROACH CONTROL (TRACON)
  ↓  [~5–10 miles final, handed to Tower]
TOWER  ←— issues landing clearance
  ↓  [aircraft exits runway]
GROUND CONTROL
  ↓  [aircraft reaches gate area]
RAMP CONTROL / GATE
```

## 4. The split, side by side

| Task | Ground | Tower |
|---|---|---|
| Pushback from gate | ✅ | ❌ |
| Taxi routing | ✅ | ❌ |
| Runway crossing | ✅ or shared | ✅ or shared |
| Hold-short instructions | ✅ | ✅ |
| Line up and wait | ❌ | ✅ |
| Takeoff clearance | ❌ | ✅ |
| Landing clearance | ❌ | ✅ |
| Go-around instruction | ❌ | ✅ |
| Runway exit instruction | ❌ | ✅ |
| Post-exit taxi to gate | ✅ | ❌ |
| Vehicle movement | ✅ | ❌ |
| Airspace management | ❌ | ✅ |
| Wake turbulence separation | ❌ | ✅ |
| Emergency coordination | support | ✅ primary |

### Nuance — small fields

At smaller fields with limited staffing, Ground and Tower are often **combined** into one
controller working both frequencies, or there is no ATC at all and pilots self-announce on a
CTAF. At a field like **SAN** they are always split — which is what makes the two-position model
here the right one for the first airport, and a thing to revisit only if a small field is ever
added.

---

## 5. Where the sim is today

Recorded so the gap sits beside the procedure. `backlog.md` holds status; this is only an honest
statement of the divergence.

| Task | Sim today |
|---|---|
| Pushback from gate | ✅ Ground, including which way the aircraft ends up facing |
| Taxi routing | ✅ Ground — shortest path, assigned via-routes, reroute, give-way, expedite |
| Runway crossing | ⚠️ Ground only. Tower cannot clear a crossing at all — see `docs/atc-runway-crossing.md` §8 and backlog Tower Slice 3e |
| Hold-short instructions | ⚠️ Structural, not instructed: routes are split at the hold line automatically. **"Hold position" is still a disabled placeholder in every hold-short and line-up menu** (`commands.ts`), so neither position can actually issue it there — only a taxiing aircraft can be held |
| Line up and wait | ✅ Tower |
| Takeoff clearance | ✅ Tower, gated on runway-clear + wake |
| Landing clearance | ✅ Tower, gated on runway-clear |
| Go-around instruction | ✅ Tower — but the stub re-establish (back to the 4 nm fix), not a climb-out into TRACON |
| Runway exit instruction | ✅ Tower (`assignExit`), limited to turnoffs the aircraft can still make |
| Post-exit taxi to gate | ✅ Ground, after a real Tower→Ground handoff |
| Vehicle movement | ❌ Not modelled — no vehicles exist. A whole class of Ground's real workload is absent |
| Airspace management | ❌ No TRACON; Tower's "airspace" is a 4 nm final and a departure that vanishes at the far threshold |
| Wake turbulence separation | ⚠️ Tower, but tracked as a single global `lastDeparture` rather than per-runway/per-pair (backlog) |
| Emergency coordination | ❌ Nothing — no emergencies, no ground stop, no ARFF |
| Visual separation | ❌ Not modelled, and arguably not meaningful without a pilot-report mechanic |
| Touch-and-go / low approach | ❌ Not modelled |
| Ramp Control | 💭 Deliberately deferred (backlog) — it adds a frequency without adding a decision until gate conflicts and pushback contention are real. Both now exist, so this is worth re-examining |
| Hot spots | ⚠️ HS1 is drawn on the scope but carries no behaviour |

The two rows worth noticing: **vehicles** and **hold position**. Vehicles are a large, entirely
missing part of Ground's job that the current design has never accounted for. "Hold position"
being a placeholder at exactly the hold-short line — the one place the real procedure most
depends on it — is a small gap with an outsized footprint, since it is half of the crossing
exchange in `docs/atc-runway-crossing.md` §5.

---

## Appendix — provenance

Sections 1–4 are supplied reference material, lightly reformatted to this repo's style. A
trailing conversational question about building the split out for **BUR** (Burbank) was dropped:
the first field here is **KSAN**, and BUR's intersecting-runway case belongs with the
second-airport work (`backlog.md`), where a crossing runway first becomes a real constraint.

Overlap is deliberate but bounded: `atc-flight-strips.md` already summarizes both positions at
the level a flight strip needs, and `atc-flight-cycle.md` already walks the handoff chain as a
sequence. Neither was edited — if a detail here contradicts one of those, this note is the
authority on *ownership* and they remain the authority on *strip fields* and *sequence*.
