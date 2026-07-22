# Ground and Tower operations — step by step

**Status:** reference material, being gathered. Parts A and B are the real operational sequences
with phraseology; §C records where the sim diverges, including a line-by-line comparison of what
it actually transmits.
**Authorities:** FAA Order 7110.65 Ch. 3 (Airport Traffic Control); AIM Ch. 4 §3.
See also `docs/atc-positions.md` (who owns what — the ownership cut through this same material),
`docs/atc-runway-crossing.md` (operation 5 in full), `docs/wake-turbulence.md` (**the** authority
on separation here — see the caution in §D before using operation 11's numbers),
`docs/atc-flight-cycle.md` (the same ground covered as a flight's phases rather than a
controller's tasks).

Examples use **Alaska 412 at San Diego**, which is this project's first field — the runway and
taxiway names below are real KSAN ones and can be taken literally.

---

# Part A — Ground Control operations

## 1. Pushback from gate

**Setup:** parked at the gate, engines off, ready to depart.

**1 — Pilot calls Ground** (or Ramp at major airports):
> *"San Diego Ground, Alaska 412, gate B6, request pushback, information Delta"*

"Information Delta" confirms the crew has the current ATIS — the recorded weather/airport
broadcast.

**2 — Ground responds:**
> *"Alaska 412, San Diego Ground, push approved, face west, expect runway 27"*

or, when it is congested:
> *"Alaska 412, hold for traffic, company 737 pushing back on your left"*

**3 — Read-back:**
> *"Push approved, face west, Alaska 412"*

**4 — The physical push** (ground crew, not ATC): a tug pushes the aircraft back, the pilot
holds the brakes, the crew clears the tug and signals. Engines start during or after the push,
per airline procedure.

**5 — Ready to taxi:**
> *"Alaska 412, push complete, request taxi"*

## 2. Taxi routing — gate to runway

**1 — Ground issues the clearance:**
> *"Alaska 412, taxi to runway 27 via Charlie, hold short of runway 27"*

**2 — Mandatory read-back:**
> *"Taxi to runway 27 via Charlie, hold short of runway 27, Alaska 412"*

**3 — The aircraft taxis:** follows the assigned route exactly; the crew crosschecks the taxi
chart against what was said, calls out each turn as they make it (CRM), and runs with strobes,
nav and taxi lights on.

**4 — On any doubt:**
> *"Alaska 412, say position"*
> *"Alaska 412, we're on Charlie approaching the 27 hold short"*

**5 — At the hold-short line:** the aircraft stops at the double solid yellow lines and does not
cross. Ground either sends it to Tower — *"Alaska 412, contact Tower 118.3"* — or Tower already
knows it is coming and calls first.

## 3. Taxi routing — runway exit to gate (arrivals)

**1 — Tower hands off after the exit:**
> *"Alaska 412, turn left Charlie, contact Ground 121.9"*

**2 — Check-in on Ground:**
> *"San Diego Ground, Alaska 412, clear of runway 27 on Charlie, taxi to the gate"*

**3 — Ground routes it:**
> *"Alaska 412, taxi to gate B6 via Charlie, Alpha"*

**4 — Read-back:**
> *"Gate B6 via Charlie, Alpha, Alaska 412"*

**5 — At major airports, Ground hands to Ramp:**
> *"Alaska 412, contact Ramp 123.85"*
> *"Ramp, Alaska 412, clear of Charlie, inbound gate B6"*
> *"Alaska 412, continue straight, we'll stop you short of the gate for a ground crew"*

## 4. Vehicle / equipment movement

**1 — The vehicle calls:**
> *"San Diego Ground, Maintenance Vehicle 4, request crossing taxiway Charlie at Alpha"*

**2 — Ground holds it:**
> *"Maintenance 4, hold short of Charlie, traffic inbound"*

**3 — Ground clears it:**
> *"Maintenance 4, cross Charlie, expedite"*

**4 — Read-back:**
> *"Crossing Charlie, Maintenance 4"*

**5 — Confirms clear:**
> *"Maintenance 4, clear of Charlie"*

Same rules as aircraft: explicit clearance, mandatory read-back, no stopping on the taxiway.

## 5. Runway crossing (Ground-managed)

Covered in full in `docs/atc-runway-crossing.md`. In brief: Ground issues a route containing the
crossing or a hold-short; the pilot reads the hold-short back explicitly; the aircraft stops at
the line; Ground either clears the crossing or hands to Tower; the crossing clearance is read
back; the aircraft crosses without stopping, lights on; it reports clear and continues.

---

# Part B — Tower (Local Control) operations

## 6. Line up and wait (LUAW)

**Setup:** the runway is not quite clear — a landing aircraft is still rolling out, or Tower
needs a moment — so rather than hold the departure on the taxiway, Tower puts it on the runway
ready to go.

**1 — Tower issues LUAW:**
> *"Alaska 412, runway 27, line up and wait"*

**2 — Mandatory read-back:**
> *"Runway 27, line up and wait, Alaska 412"*

**3 — The aircraft enters and holds on the centerline:** strobes on the moment it enters, takeoff
thrust set, checklists complete, crew watching final — and if anything looks close, they query.
If no takeoff clearance arrives within **90 seconds**, the pilot must ask:
> *"Alaska 412, holding runway 27, awaiting clearance"*

**4 — Tower clears it, or holds it:**
> *"Alaska 412, runway 27, cleared for takeoff, wind 270 at 12"*
>
> *"Alaska 412, hold position, landing traffic"*

**Critical:** LUAW is **not** a takeoff clearance. No takeoff roll until "cleared for takeoff" is
explicitly issued.

## 7. Takeoff clearance

**Setup:** holding short, or already lined up via LUAW.

**1 — Tower confirms the runway is clear:** the previous landing has exited, nothing is crossing,
and nothing on final is inside the safe window.

**2 — Tower issues it:**
> *"Alaska 412, runway 27, cleared for takeoff, wind 270 at 12, turn right heading 290 on
> departure"*

**3 — Read-back:**
> *"Runway 27, cleared for takeoff, right heading 290, Alaska 412"*

**4 — The roll:** the crew calls "thrust set", "80 knots", "V1", "rotate"; Tower watches.

**5 — Handoff to Departure**, once airborne and established:
> *"Alaska 412, contact SoCal Departure 124.35, good day"*
> *"Departure 124.35, Alaska 412, good day"*

**If it goes wrong on the roll**, Tower can cancel — but only before V1, after which the crew is
committed:
> *"Alaska 412, cancel takeoff clearance, hold position"*

## 8. Landing clearance

**Setup:** on approach, handed from Approach Control to Tower, typically 5–10 miles final.

**1 — Approach hands off:**
> *"Alaska 412, contact San Diego Tower 118.3, 8 miles final runway 27"*

**2 — Check-in with Tower:**
> *"San Diego Tower, Alaska 412, 8 miles final runway 27, full stop"*

**3 — Tower confirms runway state:** previous departure airborne and clear, no crossings in
progress, wake separation from the previous arrival met.

**4 — Tower clears it:**
> *"Alaska 412, runway 27, cleared to land, wind 270 at 10, traffic a CRJ will be departing ahead
> of you"*

**5 — Read-back:**
> *"Runway 27, cleared to land, Alaska 412"*

**6 — Tower monitors:** watching for incursions, and watching spacing behind for the next
arrival. If something enters the runway:
> *"Alaska 412, go around, go around, traffic on runway"*

**7 — After touchdown:**
> *"Alaska 412, turn left Charlie, contact Ground 121.9"*

## 9. Go-around

**Setup:** something is wrong — runway not clear, aircraft high or fast, a spacing problem, or
the pilot wants it.

**Tower-initiated**, repeated because it is urgent:
> *"Alaska 412, go around, go around, I say again go around, traffic on runway"*

then immediately:
> *"Alaska 412, fly runway heading, climb and maintain 3,000"*

**Pilot-initiated:**
> *"Going around, Alaska 412"*

Tower answers at once with instructions:
> *"Alaska 412, roger, fly runway heading, climb 3,000, I'll bring you back around"*

**Resequencing:** Tower then coordinates with Approach to slot it back into the arrival sequence:
> *"Alaska 412, turn left heading 180, descend 2,000, expect ILS runway 27 in 12 miles"*

**Critical:** go-around authority belongs to the **pilot**, always — they may initiate for any
reason at any time. Tower initiates when it sees a conflict the pilot may not.

## 10. Runway exit

**Setup:** landed, decelerating on the runway.

**1 — Tower may pre-plan the exit.** At busy airports it says so *before* landing, to cut runway
occupancy time:
> *"Alaska 412, plan Charlie for your exit"*

**2 — During rollout Tower confirms:**
> *"Alaska 412, turn left Charlie, contact Ground 121.9"*

or, if the aircraft is slowing faster than expected:
> *"Alaska 412, turn left at Alpha if able, Charlie if not"*

**3 — Acknowledgement:**
> *"Left Charlie, Ground 121.9, Alaska 412"*

**4 — Vacated.** The moment every part of the aircraft is past the hold-short line on the exit
taxiway, the runway is vacated: Tower's responsibility ends and Ground's begins.

**5 — If it misses the assigned exit:**
> *"Alaska 412, next available left, then contact Ground"*

Tower does not want an aircraft stopping on the runway to look for an exit — always take the
next available one.

## 11. Wake turbulence separation and advisory

**Setup:** a heavy or super aircraft has just departed or landed ahead of a smaller one.

**1 — Tower applies the required separation**, built into the sequence automatically.
⚠️ The distance figures that accompanied this section are **arrival** minima in FAA weight
classes and do not describe what this sim implements — see §D before using them.

**2 — Tower issues the advisory regardless:**
> *"Alaska 412, caution wake turbulence, heavy 777 departed runway 27 two minutes ago"*

**3 — Acknowledgement:**
> *"Caution wake turbulence, Alaska 412"*

This is advisory: having accepted it, the pilot is responsible for their own wake avoidance.
They may ask for more:
> *"Alaska 412 requests additional spacing for wake turbulence"*

Tower then extends the sequence.

## 12. Emergency coordination

**Setup:** the aircraft declares an emergency (MAYDAY) or urgency (PAN-PAN).

**1 — The declaration:**
> *"San Diego Tower, Alaska 412, MAYDAY MAYDAY MAYDAY, engine failure, request immediate landing
> runway 27"*

**2 — Tower clears everything:** cancels other takeoff clearances as needed, clears the runway,
stops all crossings.
> *"Alaska 412, all traffic stop. Alaska 412, runway 27 is clear, you are cleared to land,
> emergency equipment is standing by"*

**3 — Tower alerts ARFF** by interphone/hotline, not on the pilot frequency:
> *"Alert 1, Alaska 412, single engine, runway 27, souls on board 183, fuel 40,000 lbs"*

ARFF positions at designated spots alongside the runway.

**4 — Tower coordinates with Ground:** all ground traffic held, emergency vehicle access routes
to the runway cleared.

**5 — After landing:**
> *"Alaska 412, say intentions, do you require assistance on the runway?"*

---

## Who owns what, when

```
GATE ──── RAMP ──── GROUND ──── [hold short] ──── TOWER ──── DEPARTURE
         pushback    taxi         LUAW            takeoff      climb out
         start       routing      crossing        landing
         engine      vehicles     clearance       go-around
                                                  exit inst.
                     ◄──────────────────────────────────────
                     taxi to gate ◄── exit taxiway ◄── runway vacated
```

---

# Part C — Where the sim is today

### Operation coverage

| # | Operation | Sim today |
|---|---|---|
| 1 | Pushback | ✅ Including the direction it ends up facing (a real choice — the alley runs two ways). ❌ No ATIS, no "expect runway", no engine start as a distinct step |
| 2 | Taxi gate → runway | ✅ Routing, assigned via-routes, reroute. ⚠️ Hold-short is structural, never spoken as part of the clearance. ❌ No "say position" |
| 3 | Taxi exit → gate | ✅ Including a real Tower→Ground handoff and a pilot check-in. ❌ No Ramp |
| 4 | Vehicles | ❌ Nothing. No vehicles exist at all |
| 5 | Runway crossing (Ground) | ✅ Ground only — see `docs/atc-runway-crossing.md` §8 |
| 6 | Line up and wait | ✅ ❌ No 90-second query; "hold position" at the line is still a disabled placeholder |
| 7 | Takeoff clearance | ✅ Gated on runway-clear + wake. ❌ No wind, no initial heading, no cancel-before-V1 |
| 8 | Landing clearance | ✅ Gated on runway-clear. ❌ No wind, no traffic advisory, no pilot check-in with intentions |
| 9 | Go-around | ✅ Both pilot- and controller-initiated, and transmitted differently. ⚠️ Stub re-establish at the 4 nm fix — no runway heading, no climb, no resequencing |
| 10 | Runway exit | ✅ `assignExit`, limited to turnoffs still makeable, and a "when vacated, contact ground" that applies on vacating. ❌ No pre-landing "plan Charlie", no "next available" |
| 11 | Wake separation | ⚠️ Departure separation only, time-based, single global leader. ❌ No advisory transmission, no pilot request for extra spacing |
| 12 | Emergencies | ❌ Nothing — no emergencies, no ground stop, no ARFF |

### Phraseology, line by line

What `ground/comms.ts` actually transmits today, against the real form above. This is the most
directly actionable table here: most rows are a string change, not a mechanic.

| Command | Sim says | Real form adds |
|---|---|---|
| `pushback` | "push and start approved facing E" | "…**expect runway 27**"; the pilot's request names the gate and the ATIS code |
| `taxiTo` / `taxiVia` | "taxi to RWY 27 via Alpha, Bravo" | "…**hold short of runway 27**" — the clause that must be read back |
| `hold` | "hold position" | ✅ matches |
| `resume` | "continue taxi" | ✅ matches |
| `crossRunway` | "cross runway 27" | ✅ matches; Tower's adds "**no delay**" |
| `giveWay` | "give way to AAL123" | usually names the traffic's type/position too |
| `lineUpAndWait` | "runway 27, line up and wait" | ✅ matches |
| `clearedForTakeoff` | "runway 27, cleared for takeoff" | "…**wind 270 at 12**, turn right heading 290 on departure" |
| `clearedToLand` | "runway 27, cleared to land" | "…**wind 270 at 10**", plus traffic advisories |
| `assignExit` | "turn off at Bravo Six" | "**turn left** Charlie" — the *direction* is part of it |
| `contactTower` | "contact tower 118.3" | ✅ matches |
| `contactGround` | "when vacated, contact ground 121.9" | ✅ matches |
| `goAround` | "go around" | "**go around, go around, I say again go around**, traffic on runway", then runway heading + altitude |
| `expedite` | "expedite" | in a crossing it is "cross runway 27, **no delay**" |
| `clearance` | "cleared to destination as filed, squawk 4271" | route/SID, initial altitude, departure frequency (already on the backlog) |
| — | *(no equivalent)* | "say position"; wake caution; "plan Charlie for your exit"; "next available left"; "all traffic stop" |

---

# Part D — Notes on the source

**Two things to reconcile before acting on operation 11.** The wake figures given with it —
Super 6 nm, Heavy 5 nm, Large 4 nm — are **arrival, distance-based** minima expressed in **FAA
weight classes** (Small / Large / Heavy / Super). This project's implemented model is
**departure, time-based** separation in **ICAO categories** (`L | M | H | J` =
Light/Medium/Heavy/Super), and `docs/wake-turbulence.md` explicitly puts arrival distance
separation out of scope as a TRACON concern. Both are correct for their own operation; they are
not alternatives.

The trap is the vocabulary collision: FAA **"Large"** (B737, A320) is this codebase's **`M`**,
and FAA **"Small"** is roughly `L`. Mapping "Large → 4 nm" onto our `'L'` would silently apply a
separation intended for a 737 to a Cessna. `docs/wake-turbulence.md` remains the authority for
anything this sim enforces; operation 11 is useful here for the *advisory transmission*, which
we do not model at all, rather than for its numbers.

**Provenance.** Parts A and B are supplied reference material, lightly reformatted to this
repo's style; all phraseology is preserved verbatim. A trailing conversational question about
scripting a full departure and arrival at **BUR** (Burbank) was dropped, as with the previous
two notes — the field here is KSAN, and the examples above already use it. An intersecting-runway
walkthrough belongs with the second-airport work in `backlog.md`.
