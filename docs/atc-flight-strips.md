# ATC Game Design: Flight Strips & Controller Modes

## Facility Overview

Real-world ATC is divided into distinct facilities, each responsible for a specific phase of flight. The game models four controller modes that map directly to these facilities.

| Mode | Real Facility | Phase of Flight |
|---|---|---|
| **Clearance / Ground** | ATCT — Clearance Delivery + Ground Control | Pre-departure, taxi |
| **Tower** | ATCT — Local Control | Runway ops, takeoff, landing |
| **TRACON** | TRACON — Approach + Departure Control | Terminal airspace, ~0–50nm, <18,000ft |
| **Center** | ARTCC — En-Route Center | Cruise, high altitude, cross-country |

---

## Full Flight Lifecycle

### Departure Flow

```
Clearance Delivery
  ↓  issues IFR clearance (route, initial altitude, squawk code, departure freq)
Ground Control
  ↓  pushback approval, taxi routing to runway hold short line
Tower (Local Control)
  ↓  position and hold, takeoff clearance, initial heading/altitude assignment
     watches for runway conflicts, wake turbulence spacing
     may hold for TRACON departure release or wheels-up time window
TRACON Departure
  ↓  radar contact, climb instructions, vectors off the SID
     deconflicts with arrival traffic in shared terminal airspace
     climbs aircraft to TRACON ceiling (~18,000ft)
     hands off when leaving terminal airspace
Center (ARTCC)
  ↓  cruise altitude, en-route phase begins
```

### Arrival Flow

```
Center (ARTCC)
  ↓  hands off ~30–50nm out, descending from cruise altitude
TRACON Approach
  ↓  vectors, sequences, issues approach clearance
     manages speed and altitude to build final approach spacing
     handles merges from multiple arrival directions
     hands off ~5nm on final (~1,000–1,500ft AGL)
Tower (Local Control)
  ↓  clears to land, monitors runway, clears when vacated
Ground Control
  ↓  taxis to gate via assigned taxiway routing
```

---

## Controller Mode Details

### Clearance Delivery
- Issues full IFR clearance before pushback: route, initial altitude, squawk code, departure frequency
- Assigns SID (Standard Instrument Departure) if applicable
- Gameplay loop: read-back verification, queue management, slot control at busy airports

### Ground Control
- Approves pushback from gate
- Issues taxi routing to assigned runway — must deconflict crossing runways and hotspots
- Coordinates runway crossings with Tower
- Gameplay loop: pathfinding puzzle, sequence management, hotspot awareness

### Tower (Local Control)
- Manages the active runway environment
- Departure: position and hold, takeoff clearance, initial turn/altitude
- Arrival: landing clearance, go-around authority, runway exit instructions
- Wake turbulence spacing — heavies require extended intervals behind them
- Issues departure releases to TRACON; receives wheels-up time windows from Center via TRACON
- Gameplay loop: timing and spacing, runway conflict avoidance, go-around decisions

### TRACON (Approach + Departure)
- Single facility handling both arrival sequencing and departure climb-out
- At busier airports, Approach and Departure are split into separate sectors
- Departure: radar contact after handoff from Tower, vectors off SID, climbs to TRACON ceiling
- Arrival: receives from Center, sequences into final approach course (the "feeder" fix)
- Issues departure releases upstream to Tower
- Gameplay loop: most complex mode — simultaneous opposing traffic flows, speed/altitude management, sequencing under pressure

### Center (ARTCC)
- En-route cruise phase, large geographic sectors
- Issues wheels-up time windows downstream to TRACON/Tower to manage arrival flow
- Gameplay loop: big-picture flow management, sector loading, long-range sequencing

---

## Flight Strips

Flight strips are the primary UI element for tracking aircraft. The same underlying flight data object renders differently depending on the active controller mode — each position only displays what is **actionable** at that phase.

### Tower Strip

Tower is focused on the physical runway environment. Strips should be lean and fast to scan.

```
┌──────────────────────────────────────────────────────────────┐
│ AAL342   B738 /L    Heavy    Seq: 3                          │
│ RWY: 28R            WX: 280/12kt  Alt: 29.92                 │
│ Status: [ TAXI ] [ HOLD SHORT ] [ POSITION ] [ AIRBORNE ]    │
└──────────────────────────────────────────────────────────────┘
```

**Tower strip fields:**

| Field | Purpose |
|---|---|
| Callsign | Primary identifier |
| Aircraft type | Wake turbulence category (Light / Heavy / Super) |
| Equipment suffix | /L, /G, /W — IFR capability, affects clearance |
| Assigned runway | Primary focus |
| Sequence number | Queue position for departure or arrival |
| Wake turbulence category | Spacing requirements behind heavies |
| Weather | Active ATIS info — runway, wind, altimeter |
| Status flags | Current phase: taxi / hold short / position & hold / airborne / landed |

Arrivals additionally show: expected exit taxiway, rollout instructions.

Tower does **not** need: full route, squawk code, cruise altitude, next sector.

---

### TRACON Strip

TRACON works radar + routing. Strips are data-dense and supplement the radar display.

```
┌──────────────────────────────────────────────────────────────┐
│ AAL342   B738/L    AA342    Squawk: 1234                     │
│ KDAL → KPHX    RNDRZ2 SID / FINGR3 STAR                     │
│ AFL: 170   RFL: 350   Hdg: 250   Spd: 250                   │
│ Next: ZFW (Fort Worth Center)                                │
│ Status: [ RADAR CONTACT ] [ HANDOFF ] [ RELEASED ]          │
└──────────────────────────────────────────────────────────────┘
```

**TRACON strip fields:**

| Field | Purpose |
|---|---|
| Callsign | Primary identifier |
| Aircraft type + equipment | Performance planning, wake turbulence |
| Squawk code | Links strip to radar target — critical for ID |
| Origin / Destination | Situational awareness, route context |
| SID / STAR | Published procedure in use |
| Assigned altitude (AFL) | Current cleared altitude |
| Requested/filed altitude (RFL) | Where they're going — climb planning |
| Assigned heading | Vectoring reference |
| Assigned speed | Sequencing tool |
| Next sector / facility | Handoff target |
| Coordination status | Released, in-handoff, point-out |

---

### Strip Field Comparison by Mode

| Field | Clearance | Ground | Tower | TRACON | Center |
|---|---|---|---|---|---|
| Callsign | ✅ | ✅ | ✅ | ✅ | ✅ |
| Aircraft type | ✅ | ✅ | ✅ wake turbulence | ✅ performance | ✅ |
| Squawk code | ✅ assigned | — | — | ✅ primary ID | ✅ |
| Full route | ✅ | — | — | ✅ | ✅ |
| SID / STAR | ✅ | — | — | ✅ | ✅ |
| Assigned altitude | ✅ initial | — | ✅ initial only | ✅ full | ✅ |
| Filed/cruise altitude | ✅ | — | — | ✅ | ✅ |
| Assigned heading | — | — | ✅ initial turn | ✅ | — |
| Assigned speed | — | — | — | ✅ | ✅ |
| Runway | — | ✅ taxi target | ✅ primary | ✅ arrivals | — |
| Taxi route | — | ✅ | — | — | — |
| Sequence number | — | ✅ | ✅ | ✅ arrivals | — |
| Next sector | — | — | — | ✅ | ✅ |
| Status flags | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Gameplay Notes

### The Strip as a State Machine
Each strip represents a flight in a specific phase. Status flags should drive what actions are available to the player. A strip in `HOLD SHORT` state should only offer `POSITION & HOLD` or `LINE UP AND WAIT` — not `CLEARED TO LAND`. Constraining available actions to phase-appropriate options reduces errors and models real-world discipline.

### Handoff Mechanics
Handoffs are the transitions between modes. In real ATC, a controller initiates a handoff on radar, the receiving controller accepts, and only then does the frequency change happen. In-game this is a meaningful moment — a botched or late handoff creates downstream pressure. Consider:
- Auto-handoff at boundary (easy mode)
- Manual initiation required (realistic mode)
- Handoff refusal if receiving sector is overloaded

### Departure Releases & Wheels-Up Times
TRACON issues departure releases to Tower — Tower cannot send a departure without one during busy periods. Center can issue wheels-up time windows that flow down through TRACON to Tower. These constraints are good tension generators for the Tower gameplay loop.

### Wake Turbulence
Heavy and Super aircraft generate wake turbulence that requires extended spacing for following aircraft. Strip should always display wake turbulence category. Tower mode should enforce minimum spacing intervals and flag violations.

### ATIS
Automatic Terminal Information Service provides the current active runway, weather, altimeter setting, and NOTAMs. Not a controller role but should be modeled as ambient context that all strips reference. Changing ATIS (runway change due to wind shift) is a high-pressure event that cascades across all modes simultaneously.

### Go-Arounds
Tower has authority to issue a go-around at any point. This ripples back into TRACON — the aircraft re-enters the arrival sequence, displacing other traffic. A good go-around event is one of the best ways to stress-test the TRACON sequencing gameplay loop.

---

## References

- FAA Order 7110.65 — Air Traffic Control (the real controller handbook)
- FAA JO 7110.65Y — current edition
- Phraseology reference: AIM Chapter 4 (Air Traffic Control)
- Wake turbulence categories: FAA AC 90-23G
