# ATC Game Design: Aircraft Flight Cycle

Complete operational sequence for departure and arrival phases, mapped to ATC controller modes.

---

## Departure Cycle

### Gate / Ramp Phase

#### Clearance Delivery
- Pilot contacts clearance delivery before any movement
- Controller issues full IFR clearance:
  - Route (SID + airways + destination)
  - Initial altitude (often a low altitude until departure instructions kick in)
  - Squawk code (unique transponder identifier for radar)
  - Departure frequency (who to call after takeoff)
  - Any special instructions (crossing restrictions, noise abatement)
- Pilot reads back the clearance in full — controller must verify accuracy before approving
- Gameplay: read-back verification, slot time management at busy airports

#### Ground Servicing (Concurrent with clearance and boarding)
All of the following happen in parallel — the aircraft cannot push until all are complete:

| Service | Detail |
|---|---|
| **Fueling** | Tanker connects, fuel loaded to planned block fuel figure |
| **Catering** | Galley carts swapped — food, beverage, duty-free |
| **Lavatory service** | Lav truck empties waste tank, refills blue fluid |
| **Potable water** | Water truck refills drinking water tanks |
| **Cargo & baggage** | Bags loaded per weight and balance plan, cargo containers loaded |
| **Cabin cleaning** | Seat pockets cleared, lavatories cleaned, vacuum run |
| **GPU (Ground Power Unit)** | External power connected so APU can be shut down at gate |

This is a real constraint window — the aircraft cannot push until the last service is complete. Modeling this as a parallel countdown before pushback is available adds realistic pressure.

#### Passenger Boarding
- Gate agent scans boarding passes by zone
- Preboarding: passengers needing assistance, families, elite frequent flyers
- Zone boarding: typically rear-to-front or window-to-aisle
- Final boarding call, door close warning
- Gate agent confirms final headcount against manifest
- Forward door closes — this triggers the next phase

#### Preflight Complete
- Pilots complete cockpit preflight checklist
- Weight & balance sheet finalized — reflects actual passenger count, cargo weight, fuel load
- Loadsheet signed by captain — legally required before departure
- Performance calculations confirmed: V speeds (V1, VR, V2), thrust setting, takeoff distance
- Doors closed and cross-checked by cabin crew
- "Cabin secure" call from lead flight attendant to captain

---

### Ramp / Pushback Phase

#### Pushback & Engine Start
- Pilot contacts ground (or ramp control at large airports) for pushback clearance
- Tug driver connects towbar to nose gear
- Tug pushes aircraft clear of gate — pilot and tug driver communicate via headset
- Engine start sequence during pushback or after:
  - APU provides bleed air for pneumatic start
  - Engines start one at a time (typically engine 2 first on most jets)
  - Engine parameters stabilize — N1, N2, oil pressure, EGT checked
- Towbar disconnects when aircraft is clear and engines are running
- "Thumbs up" from tug driver — aircraft is on its own
- Gameplay: pushback clearance from ramp, coordination with adjacent gate traffic

---

### Ground Control Phase

#### Taxi to Runway
- Pilot contacts ground control on assigned frequency
- Ground issues taxi route to assigned runway:
  - Taxiway sequence (e.g. "Taxi via Alpha, Bravo, hold short of runway 28R")
  - Runway crossing clearances where applicable
  - Hotspot advisories (areas of known confusion or incursion risk)
- Pilots read back full taxi clearance including hold short instructions
- Ground monitors all movement on the surface — deconflicts crossing paths
- At complex airports, multiple ground frequencies may split the surface (north/south ramp, inner/outer)
- Gameplay: pathfinding puzzle, taxiway deconfliction, hold short awareness

#### Hold Short of Runway
- Aircraft stops at the runway hold short marking (yellow double-bar line)
- Pilot switches to Tower frequency
- Pre-takeoff checklist completed: flaps set, trim set, transponder to ALT, lights on
- Before entering the runway, must have explicit Tower clearance — no exceptions

---

### Tower (Local Control) Phase

#### Departure Release / Wheels-Up Time
- Tower must have a departure release from TRACON before sending a departure
- During busy periods, TRACON issues releases one at a time to control the departure flow
- Center sometimes issues wheels-up time windows — a specific time range the aircraft must be airborne within
  - Tower holds the aircraft at the runway until the window opens
  - Miss the window and a new one must be negotiated
- Gameplay: high-tension hold mechanic — the sequence can back up behind a delayed wheels-up

#### Line Up and Wait (LUAW)
- Tower clears aircraft to enter and hold on the runway without takeoff clearance
- Used to pre-position aircraft when the runway will be clear shortly
- Wake turbulence timing: if a heavy or super departed recently, Tower enforces a mandatory interval before the next departure can line up
- Aircraft must not begin takeoff roll without explicit takeoff clearance

#### Takeoff Clearance
- Issued when runway is clear and conditions are met
- Includes: runway, current wind, any special instructions (fly runway heading, turn left heading 270, etc.)
- Pilot reads back runway and any heading/altitude restrictions
- Rotation: aircraft accelerates to VR, rotates, becomes airborne

#### Airborne — Initial Climb
- Tower monitors aircraft until it clears the airport environment
- Issues initial turn or altitude instructions if not already given
- At a pre-briefed altitude or point, Tower says "contact departure" — frequency change to TRACON
- Transponder confirmed in ALT mode — squawk is now painting on radar

---

### TRACON Departure Phase

#### Radar Contact
- Pilot checks in with TRACON departure on assigned frequency
- Controller confirms radar contact by calling out aircraft's position and altitude
- Squawk confirmed — strip is now linked to the radar target
- Initial climb and heading instructions issued

#### SID Climb-Out
- SID (Standard Instrument Departure) is a published procedure that routes departures efficiently out of the terminal area
- Contains altitude crossing restrictions, speed limits, required turns
- TRACON may assign vectors off the SID if traffic deconfliction requires it ("fly heading 270, vectors for traffic")
- Departure controller climbs aircraft through the terminal airspace while deconflicting with arrival traffic flowing the opposite direction
- This is the most complex TRACON task — two opposing traffic flows in shared airspace
- Gameplay: altitude and lateral deconfliction, speed management, SID deviation decisions

#### Handoff to Center (ARTCC)
- As aircraft approaches the TRACON ceiling (~18,000ft or the terminal area boundary)
- TRACON initiates handoff to the appropriate Center sector
- Center accepts — pilot frequency change
- TRACON's responsibility ends

---

### Center / En-Route Phase

#### En-Route Cruise
- Center assumes control for the long cruise phase
- Climbs aircraft to filed cruise altitude if not already there
- Issues sector-to-sector handoffs as aircraft crosses Center boundaries
- Large geographic sectors — Center may handle aircraft for 30–90 minutes
- Gameplay: big-picture flow management, sector loading, metering into destination TRACON

#### Top of Descent
- Center calculates or receives TOD point from the FMS (Flight Management System)
- Descent clearance issued — "descend via the STAR" or a direct altitude assignment
- Speed begins reducing toward terminal area limits
- Handoff initiated to destination TRACON

---

## Arrival Cycle

### Center / En-Route (Arrival Entry)

#### Top of Descent
- Center issues descent clearance — "descend and maintain FL240" or "descend via the [STAR name] arrival"
- Aircraft begins long-range descent (typically 3nm per 1,000ft of altitude)
- Speed reduction begins — slowing toward 250 kts below 10,000ft
- Center may issue wheels-in-well time (APREQ) to meter traffic into the TRACON

#### Handoff: Center → TRACON Approach
- Approximately 30–50nm from the destination airport
- Center initiates radar handoff — TRACON accepts
- Pilot frequency change to approach control

---

### TRACON Approach Phase

#### Radar Contact
- Approach controller confirms radar contact
- Squawk verified, altitude confirmed
- Initial descent and speed instructions issued
- Aircraft assigned to the arrival sequence — a slot in the queue

#### STAR (Standard Terminal Arrival Route)
- Published routing that channels arrivals from the en-route structure down into the terminal area
- Contains altitude and speed restrictions at named fixes
- Multiple STARs feed from different directions into common feeder fixes
- Gameplay: aircraft arrive on different STARs — the controller must merge them into a single stream

#### Sequencing — Feeder Fix
- The most complex and high-pressure phase of approach control
- Traffic arrives from multiple directions simultaneously
- Controller uses speed control, altitude control, and vectors to build the sequence:
  - Slow aircraft down to create spacing
  - Speed up aircraft that are falling behind sequence
  - Issue 360-degree turns or extended vectors to absorb excess arrivals
- Target: 3–5nm spacing on the final approach course (instrument conditions), 2.5nm minimum
- Wake turbulence: heavies require extended spacing behind them — 4–6nm for a following light aircraft
- Gameplay: the core loop of approach mode — building and defending the sequence under pressure

#### Vectors to Final
- Controller issues headings to intercept the final approach course (ILS localizer or RNAV final)
- Typical intercept: 30-degree angle to the final, at or below glideslope intercept altitude
- "Turn left heading 090, intercept the localizer runway 28R, maintain 3,000 until established"
- Speed assignment: typically 180 kts on base, 160 kts on final until 5nm, then pilot's discretion
- Gear down, flaps extending as aircraft slows on the approach

#### Approach Clearance
- Issued once aircraft is established or about to intercept the final approach course
- "Cleared ILS runway 28R approach" or "Cleared RNAV runway 28R approach"
- Aircraft now on a published procedure — altitude and course are defined by the approach plate
- Approach controller begins planning the handoff to Tower

#### Handoff: TRACON → Tower (~5nm final)
- Approximately 5nm from the runway threshold (roughly 2 minutes to touchdown)
- Aircraft is established on final, gear down, configured for landing
- TRACON hands off to Tower
- Pilot frequency change to Tower

---

### Tower (Local Control) — Arrival Phase

#### Cleared to Land
- Tower verifies runway is clear of traffic and obstacles
- "N123AA, runway 28R, cleared to land, wind 270 at 12"
- For visual approaches: "traffic to follow is a 737 on a 5-mile final, report in sight"
- Tower monitors aircraft on final and is prepared to issue a go-around at any time

#### Go-Around (If Required)
Issued when the runway cannot be used for the planned landing:
- **Runway incursion**: another aircraft or vehicle has entered the runway
- **Unstable approach**: aircraft is too high, too fast, or not configured
- **Wake turbulence**: preceding heavy has not cleared the area
- **Traffic not in sight**: visual approach but pilot cannot see the preceding aircraft
- **Runway not clear**: landing aircraft has not vacated in time

Go-around procedure: full power, climb straight ahead, contact departure or approach as instructed. Aircraft re-enters the TRACON arrival sequence — this displaces other traffic and creates downstream pressure.

**Gameplay note**: the go-around is one of the best stress-test events for TRACON sequencing. The aircraft re-enters the flow and the controller must find a new slot for it without disrupting the rest of the sequence.

#### Touchdown & Rollout
- Pilot crosses the threshold at ~50ft, flares, touches down in the touchdown zone
- Thrust reversers deployed (jet aircraft), wheel brakes applied
- Rollout to a manageable speed (~20 kts)
- Tower assigns runway exit taxiway: "turn right on Bravo, contact ground 121.9"

#### Clear of Runway
- Pilot turns off the active runway at the assigned exit
- Calls Tower: "28R clear, Bravo"
- Tower acknowledges and can now clear the next arrival to land
- This call is operationally critical — the next aircraft may be 30 seconds from the threshold

#### Handoff: Tower → Ground Control
- Once clear of all runways, pilot switches to Ground frequency
- Tower responsibility ends

---

### Ground Control — Arrival Phase

#### Taxi to Gate
- Ground issues taxi routing from runway exit to assigned gate
- Must deconflict with departing traffic crossing taxiways
- Runway crossing clearances: aircraft cannot cross an active runway without explicit clearance from Tower (not Ground — this is a common misconception)
- At complex airports, multiple ground frequencies may be in use
- Gameplay: reverse pathfinding puzzle — arrivals flowing inbound against departures flowing outbound

---

### Gate / Ramp — Arrival Phase

#### Parking
- Ramp agent or marshaller guides aircraft into gate
- AGNIS (Azimuth Guidance for Nose-In Stands) or PAPA docking system provides visual stop/center guidance to the pilot
- Aircraft stops at the painted stop mark

#### Engines Off — Chocks In
- Engines shut down in sequence
- Ground crew places wheel chocks immediately
- Jetway extends and connects to the forward door
- GPU (Ground Power Unit) connected — external power replaces APU
- Fuel panel closed, fuel receipt signed

#### Deboarding
- Forward door opens — passengers deplane via jetway
- Cabin crew manages deboarding, collects gate-checked items
- Passengers with connections move to next gate
- Final passenger off — crew begins cabin check

#### Turnaround Begins
- The aircraft immediately enters the next departure cycle
- Ground services connect simultaneously: baggage offload, cleaning crew boards, catering swap begins
- The turnaround time (typically 45–60 minutes for a narrowbody, 90+ for a widebody) determines when the next departure cycle can begin
- Short turns at hub airports are one of the highest-pressure operational scenarios — any delay in the arrival cascades directly into the departure

---

## Handoff Summary

| From | To | Trigger |
|---|---|---|
| Clearance Delivery | Ground Control | Clearance read-back complete |
| Ground Control | Tower | Aircraft at runway hold short |
| Tower | TRACON Departure | Aircraft airborne, climbing |
| TRACON Departure | Center (ARTCC) | Leaving terminal airspace |
| Center (ARTCC) | TRACON Approach | ~30–50nm from destination |
| TRACON Approach | Tower | ~5nm final, established on approach |
| Tower | Ground Control | Aircraft clear of all runways |
| Ground Control | Ramp | Aircraft at gate |

---

## Gameplay Design Notes

### Parallel Servicing as a Constraint Timer
Ground servicing runs in parallel but each service has its own completion time. Fueling is often the long pole. Modeling this as a set of parallel countdown bars before pushback becomes available adds realistic pressure without requiring the player to manage each service directly.

### Wheels-Up Time Windows
Center issues these to manage en-route flow. Tower receives them via TRACON. The aircraft must be airborne within a narrow window — miss it and a new slot must be negotiated, which may push the aircraft to the back of the departure queue. This is a natural source of cascading delay.

### The Go-Around Cascade
A single go-around ripples through the entire system: the aircraft re-enters TRACON sequencing, displacing the next 2–3 arrivals, which may push some below minimum fuel, which may require priority handling, which affects the departure release schedule. Building this cascade correctly makes TRACON the most interesting and high-stakes mode in the game.

### Turnaround as a Departure Gate
The arrival cycle feeds directly into the departure cycle for the same aircraft. Gate conflict — when an arriving aircraft's gate is occupied by a late-departing aircraft — is a real operational nightmare and a compelling gameplay mechanic at the Ground/Ramp level.

### Wake Turbulence as a Sequencing Constraint
Heavy and Super aircraft impose mandatory spacing on following aircraft. This is not optional — it is a hard constraint that the approach controller must honor. A sequence of Heavy → Light → Light → Light is a forced spacing event that slows the entire flow. Modeling wake turbulence categories on strips is essential for authentic TRACON gameplay.

---

## References

- FAA Order 7110.65 — Air Traffic Control (controller handbook)
- FAA AC 90-23G — Aircraft Wake Turbulence
- ICAO Doc 4444 — PANS-ATM (international procedures)
- AIM Chapter 4 — Air Traffic Control (pilot perspective)
- FAA JO 7210.3 — Facility Administration
