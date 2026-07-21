# Lessons from KSAN

Every entry below is a bug that actually shipped, or an assumption that turned out to be wrong,
while building the first airport. They are written as **checks to run on the next field**, because
most of them will recur otherwise — several were caught only by play-testing, and two were caught
by a review after passing a full test suite.

Ordered by how expensive they were.

---

## Data and domain

### 1. Arrivals and departures using opposite directions

**What happened.** The game landed RWY 09 while departing RWY 27 — head-on on a single runway. It
survived for weeks because runway occupancy stopped them ever being on the pavement together, so
nothing looked wrong.

**Why.** The arrival approach and the departure target were configured independently and never
cross-checked.

**Check.** Derive both from one configuration object. Assert the landing and departure bearings
agree to within a few degrees — `runwayConfig.test.ts` does this, and it fails loudly on the old
behaviour.

### 2. The landing threshold is not the end of the pavement

**What happened.** Thresholds were taken from the runway polyline's endpoints. Both KSAN
thresholds are displaced — 1,000 ft on 09, **1,810 ft** on 27 — so arrivals were touching down a
third of a mile short of the field, and threshold bars were painted in the wrong place.

**Check.** Pull NASR *before* modelling. Assume every runway end is displaced until the data says
otherwise.

### 3. Declared distances don't reduce to two points

**What happened.** Having found the displaced thresholds, the obvious next step was to compute LDA
as threshold→far end. That works on RWY 27 and is wrong on RWY 09 by **1,100 ft** — the last
stretch of pavement is physically there but is not declared.

**Check.** Carry `toraFt`/`ldaFt` as published numbers and *use* them. A review caught that they
were being stored but never consulted, which is worse than not having them.

### 4. Assuming which end has the ILS

**What happened.** Both the repo's notes and a written brief said KSAN's ILS is on 27. It is on
**09**; 27 is localizer-only with a steep 3.5° path. This propagated into a "to acquire" list for
a chart that does not exist.

**Check.** `ILS_TYPE` per end in NASR, and the d-TPP metafile for what is actually published.

### 5. Reading a remark backwards

**What happened.** `EMAS … LCTD AT DER 27` means the **departure** end of runway 27 — the west
end. A brief placed it at the east end. It arrests westbound overruns, which is what a landing on
27 is.

**Check.** DER = departure end. Cross-check against the airport diagram, which does label EMAS.

### 6. Guessing chart types from filenames

**What happened.** Ten departure procedures filed as STARs; two ILS approaches filed as SIDs; a
"to acquire" list that was mostly charts which don't exist while the folder already held them
mislabelled.

**Check.** Use the d-TPP metafile. See `docs/airport-data-pipeline.md` §2.

---

## Geometry derived from OSM

### 7. Measuring an angle from the first polyline vertex

**What happened.** Turnoff angles were measured from the runway to the connector's first vertex.
On a densely digitized fillet that first step is nearly parallel to the runway, so every exit
looked like a 6–20° high-speed. Measured over a fixed **distance** instead, the same connectors
came out 23–89°, matching the diagram.

**Check.** Measure direction over a fixed arc length, never between adjacent vertices.

### 8. Per-vertex curvature is noise

**What happened.** Turn-speed limits derived from adjacent-vertex curvature read survey jitter as
a **60 ft radius**, capping everything at ~10 kt. Connector polylines in the same dataset range
from 2 to 24 points, so vertex spacing means nothing.

**Check.** Compute curvature over a fixed window (`CURVE_WINDOW_NM`), and sanity-check the output
against real design values — a high-speed exit should come out 30–50 kt, a 90° turnoff 10–18 kt.

### 9. Graph topology is not the same as clearance

**What happened.** "Clear of the runway" was defined as reaching the end of the connector's
contracted graph edge. Some of those end at a fillet node barely **100 ft** off the centerline.
That released the runway while the aircraft was still on it, and made a stub look like the
cheapest turnoff on the field.

**Check.** Define vacated by a measured clearance from the centerline, and trim or extend the
geometry to end exactly there.

### 10. A tolerance band is not a position

**What happened.** `onRunway` uses a 121 ft band — deliberately wider than the 100 ft pavement
half-width so occupancy detection is forgiving. Reusing that same predicate to choose *where to
line up* let the aircraft stop on a connector node **110 ft off the centerline**.

**Check.** Predicates built for tolerance must not be reused for positioning. This one shipped
three separate times in different forms.

### 11. A route to a point on the runway is a chord

**What happened.** Line-up followed the aircraft's `held` clearance, expecting the connector's
curve. Routing to a point *on* the runway stops at the hold-short node and appends the exact goal,
so `held` is a straight chord — the aircraft cut the corner and kinked onto the centerline.

**Check.** The curve lives in the routing graph, not in the route. Route through the graph when
you need geometry.

---

## Modelling

### 12. Reusing a derivation whose filters don't apply

**What happened.** Runway exits are filtered to one landing direction and the far half of the
runway — correct for "where can a landing turn off", wrong for "where can a departure enter". The
route builder could select B4 and never go there.

**Check.** When reaching for an existing derivation, re-read its filters against the new question.

### 13. Predicates that stop blocking early

**What happened.** A departure stops blocking the runway once past rotation speed — sound *only*
because everything rolls the same direction. `setRunway` reused that predicate, so the airport
could be turned around with a jet still rolling at 130 kt.

**Check.** When a predicate's correctness rests on an invariant, note it, and re-check every new
caller against that invariant.

### 14. The UI re-deriving a sim rule

**What happened.** The command menu re-derived "is this aircraft on short final" from a
display-rounded distance. Between 1.50 and 1.55 nm it disagreed with the sim and showed a dead
button.

**Check.** Expose the predicate as a boolean on the snapshot. The UI should never recompute a
rule the sim owns, and never compute anything from a rounded display value.

### 15. Global state that should have been per-thing

**What happened.** Wake separation tracks a single `lastDeparture`. Fine for one runway; wrong the
moment there are two, where a departure on one runway would wake-gate a departure on the other.
Still outstanding — noted here so it isn't rediscovered.

**Check.** Before adding a second of anything, grep for state that assumes one.

### 16. Refusal messages that describe the wrong problem

**What happened.** "Insufficient runway remaining — RWY 27 is in use" was a *configuration*
problem worded like an *occupancy* problem, and cost a play-test session to diagnose.

**Check.** A refusal should name the actual cause and, where possible, the fix.

---

## Process

### 17. A single-airport test suite cannot catch airport coupling

Every one of the KSAN-coupled bugs passed a green suite. The fictional-airport test in
`world/airport.test.ts` caught a real bug **minutes after being written** — an object keyed by
runway designator silently reordered, because JavaScript iterates integer-like keys numerically.

**Check.** Keep that test, and add one per new field. A test that only exercises the real airport
proves the real airport still works, not that the code is general.

### 18. Synthetic fixtures that don't resemble real data hide bugs

Test surfaces used 2-point straight connectors. Real ones have up to 24 points and curve. Several
geometry bugs were invisible until run against KSAN.

**Check.** Give at least one fixture the awkward shape of real data — a curved, densely digitized
connector, and a displaced threshold.

### 19. Play-testing finds what tests don't

Corner-cutting on turnoffs, lining up off-centre, the misleading refusal, clearance offered on a
taxiway, the HUD overlap — all found by looking at it, none by the suite.

**Check.** Fly each slice before calling it done. `CLAUDE.md` already asks for an end-to-end
scenario test per slice; that catches sequencing bugs, not *appearance* bugs.

### 20. Chart cycles expire

`docs/SAN` sat on an expired cycle, and the FAA had removed it from the server. Record the cycle
in the folder README and refresh deliberately.

---

## The ramp and the router

Added after modelling stands and turn constraints. Same rule: each is a bug that shipped.

### 21. A gate node is a label, not a parking spot

**What happened.** Stands were single points taken from OSM gate nodes, so arrivals cut across the
apron to reach them and pushback shoved the aircraft toward whatever graph node was nearest —
"backing off the stand in directions the paint never goes."

**Why.** A gate node marks the stand *at the terminal*, a median **28 m** in from where the nose
actually stops. Aircraft parked on it were a plane's length off the paint, so every manoeuvre that
started from the stand started wrong. Five derived Terminal 1 stands parked *inside the building*.

**Check.** Model a stand as its painted lead-in line (`ground/stands.ts`). Assert no stop mark
falls inside a terminal polygon, and that each is nearer a terminal than its own entry.

### 22. Matching stands by proximity picks the neighbour's line

Adjacent stands sit closer together than a gate node sits from its own line. Measured at KSAN,
nearest-endpoint matching agreed with the correct answer on only **19 of 32** stands.

**Check.** Match `parking_position` ways to stands **by designator**. And do not assume the
designators share the gate numbering — KSAN's refs `1`–`14` look like an old Terminal 1 scheme
and are actually east-side and commuter stands.

### 23. OSM way direction is not consistent

28 of KSAN's lead-in lines run taxilane→stand and 4 run the other way. Trusting the winding order
would have parked one stand in eight facing backwards.

**Check.** Resolve orientation per line against independent geometry, then assert the result
against something that didn't feed the rule — terminal polygons, in our case.

### 24. A node-keyed router cannot see turns at all

**What happened.** The taxi router planned **8 near-reversals (150°–180°)** into ordinary KSAN
gate→runway routes, for months, invisibly. Aircraft pirouetted at junctions.

**Why.** Dijkstra over bare nodes: the cost of reaching a junction carries no memory of how you
entered it, so a turn angle is not a thing the search can even express.

**Check.** Search (arriving edge → node) states. Survey the turn distribution on a new field
*before* choosing a threshold — KSAN's had a wide empty band between 60° and 150°, which is what
made 120° safe. A field without that gap needs the threshold justified, not copied.

### 25. A physical constraint leaks at every seam you forget

The turn limit was added to the router and reviewed as correct. Two seams bypassed it, both found
by a reviewer *reproducing* rather than reading:

- **A stop released it.** Commitment was derived from live groundspeed, so any hold — controller,
  give-way, reservation — freed the aircraft to be re-cleared into an on-the-spot U-turn. Holds
  are the normal way a clearance gets revisited, so this was the mainline path.
- **`routeVia` was never converted.** A plain clearance refused a reversal while `taxi via <the
  taxiway it is already on>` accepted one and drove the aircraft back over itself.
- A third: the join leg from an aircraft's *position* onto the graph had no turn accounting at
  all, so a fallback could reverse it onto the network.

**Check.** When adding a physical constraint, enumerate every path that produces a route — not
just the obvious one — and every state in which it should still hold. Ask specifically: what
happens when the aircraft is *stopped*?

### 26. Test fixtures can encode manoeuvres no aircraft can perform

Adding the turn limit failed three existing tests. All three were correct failures: a synthetic
field's rapid exit joined the parallel at 152° to reach a gate placed behind it, and two stand
tests taxied an aircraft to the runway and then told it to drive back to its stand.

**Check.** When a new physical rule breaks a test, work out whether the *test* was describing
something impossible before relaxing the rule. Note this cuts both ways — one of my own new tests
passed against the old buggy code and had to be rewritten until it discriminated.
