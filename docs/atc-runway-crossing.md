# Runway crossings — procedure note

**Status:** reference material, being gathered. Sections 1–7 describe real-world procedure;
§8 records where the sim currently diverges from it. Expect this note to grow — it is the
source for the **Tower crossing** work (`backlog.md`, Tower Slice 3e) and for tightening
Ground's own crossing clearance.
**Authorities:** FAA Order 7110.65 Ch. 3 §7 (taxi and ground movement) and §2-4 (pilot
acknowledgment / read back); AIM Ch. 4 §3 (airport operations). Paragraph numbers move between
editions — cite the chapter, verify the paragraph against the current one before relying on it.
See also `docs/atc-positions.md` (who owns what), `docs/atc-operations.md` (this is
operation 5 there), `docs/atc-tower.md`,
`docs/atc-flight-cycle.md`, `docs/atc-flight-strips.md`.

A runway crossing is one of the highest-risk operations in ground movement, which is why the
procedure is this deliberate. Nearly every rule below exists because an incursion happened
without it.

---

## 1. The setup

The aircraft is taxiing and its route requires it to **cross an active or potentially active
runway** to reach its destination.

## 2. Ground issues the taxi instruction

The route either contains the crossing:

> *"[Callsign], taxi to runway 26 via Alpha, cross runway 15, then Bravo"*

…or stops the aircraft short of it:

> *"[Callsign], taxi to runway 26 via Alpha, **hold short of runway 15**"*

## 3. The pilot reads it back — explicitly

A hold-short or crossing instruction **must be read back verbatim**. This is mandatory, not
courtesy:

> *"Taxi via Alpha, hold short of runway 15, [Callsign]"*

or, when cleared across:

> *"Cross runway 15, then Bravo, [Callsign]"*

ATC **must** receive the read-back before the aircraft moves toward the runway.

## 4. Approaching the hold-short line

The aircraft taxis to the **runway hold position** — two solid yellow lines plus two dashed
lines painted across the taxiway — and **stops there** unless already cleared to cross.

Independently of ATC, the crew:

- verifies nothing is on final, visually and on the traffic display
- checks the runway is clear in both directions
- confirms the clearance out loud between crew members (CRM)
- confirms it is the *right* runway, by the number painted on the pavement

## 5. Holding — request, or wait

An aircraft told to hold short **cannot cross** until explicitly cleared. It waits for Ground,
or asks:

> *"[Airport] Ground, [Callsign], holding short runway 15, ready to cross"*

Ground then does one of two things:

**A — keeps the aircraft and clears it:**
> *"[Callsign], cross runway 15"*

**B — hands it to Tower for the crossing:**
> *"[Callsign], contact Tower 118.3 for runway 15 crossing"*

## 6. If handed to Tower

The aircraft switches and checks in:

> *"[Airport] Tower, [Callsign], holding short runway 15 on Alpha, request crossing"*

Tower either clears it:

> *"[Callsign], cross runway 15, no delay"* — "no delay" is a specific instruction, not filler

or holds it, **with the reason**:

> *"[Callsign], hold short runway 15, traffic on a 3 mile final"*

## 7. The crossing, and getting back

Once cleared:

- cross **without stopping** — "no delay" means exactly that
- all crew scan both directions throughout
- no checklists, no radio tuning, nothing that keeps the aircraft on the surface
- at night or in low visibility, runway edge and centerline lights confirm being on, and then
  clear of, the runway

Once fully across and past the hold-short line on the far side, if Tower ran the crossing the
aircraft goes back to Ground:

> *"[Callsign], runway 15 clear, contact Ground 121.9"*
>
> *"[Airport] Ground, [Callsign], clear of runway 15, continuing to runway 26"*

### The critical rules

| Rule | Detail |
|---|---|
| **Never cross without explicit clearance** | "Taxi to runway 26" does **not** authorize crossing intermediate runways |
| **Mandatory read-back** | Hold-short and crossing clearances are read back in full |
| **One runway at a time** | Clearance to cross runway 15 does not authorize runway 33, even if it is also on the route |
| **Lights on** | Strobes / landing lights when crossing any runway, day or night |
| **No delay** | Once on the runway, clear it as fast as is safe |

### Why "taxi to runway 26" does not mean "cross everything"

A famous gotcha. In the US a taxi clearance to the destination runway does **not** implicitly
authorize crossing any intermediate runway; each crossing needs its own explicit clearance.
This was tightened significantly after a series of runway incursions — it is a rule with
accidents behind it, which is the reason to model it faithfully rather than conveniently.

---

## 8. Where the sim is today

Recorded here so the gap is visible in the same place as the procedure. See `backlog.md` for
status; nothing in this section is a plan, only an honest statement of the divergence.

| Procedure | Sim today |
|---|---|
| Route may embed the crossing ("…cross runway 15, then Bravo") | ❌ Never embedded (the clearance does now say **"hold short of runway N"**, which is the other half of §2). A route that crosses a runway is **always** split at the hold line (`splitRouteAtRunway`) and the far portion held until a separate `crossRunway` clearance releases it. Conservative in the right direction — it is the "taxi to" rule enforced structurally — but it means the one-instruction form does not exist. |
| Hold short of a *named* runway | ✅ Both a clause in the taxi clearance ("taxi to runway 27 via Charlie, hold short of runway 27") and a standalone instruction, named and read back. It also **takes back a crossing clearance** the aircraft has not acted on yet — the counterpart to "cancel takeoff clearance" — and refuses once it is on the pavement. |
| Mandatory verbatim read-back | ⚠️ Every instruction is read back, and the hold-short and crossing clauses now come back with the runway in them — but no instruction is *classified* as read-back-mandatory, so a missing read-back is not yet a thing that can go wrong. |
| Ground clears the crossing (option A) | ✅ `crossRunway`, gated on `blocksRunway` (surface occupants + anyone inside short final). |
| Ground hands off for the crossing (option B) | ✅ `contactTower` takes a transit — including an arrival, which crosses to reach its gate — and says what the handoff is for. |
| Tower clears a crossing | ✅ Tower's hold-short menu splits on what the aircraft is there for: a transit gets **Cross runway** and not the departure vocabulary, gated on the same runway-clear predicate the sim refuses with. |
| "No delay" as a distinct instruction | ✅ Tower's crossing clearance carries it; Ground's does not. (`expedite` remains the separate, stronger instruction for an aircraft already moving.) |
| Hold with a stated reason ("traffic on a 3 mile final") | ✅ The instruction names the traffic it is issued for — an inbound at its range in whole miles, or an occupant on the runway — and says nothing when nothing is in the way. Absent from the read-back: a cause is not a clearance. |
| Return to Ground after crossing | ✅ "when clear of the runway, contact ground" — armed when issued mid-crossing, applied the moment the aircraft is off the pavement. Nothing is re-routed: a transit is already taxiing its own clearance. |
| One runway at a time | ➖ Not yet meaningful: KSAN is single-runway. It becomes real at the first intersecting-runway field (backlog: second airport). |
| Lights on when crossing | ➖ Not modelled; no aircraft lighting state exists. |

---

## Appendix — provenance

Sections 1–7 are supplied reference material, lightly reformatted: headings normalized to this
repo's style, and a trailing conversational question about mapping the procedure onto **BUR**
(Burbank) dropped, since the first field here is **KSAN**. If the BUR/intersecting-runway
walkthrough is wanted, it belongs with the second-airport work rather than in this note.
