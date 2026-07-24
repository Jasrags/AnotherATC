# KBUR — a runway-operations scenario

A worked session at Hollywood Burbank that threads runway **state**, **designation**, and a
**configuration change** through a full departure and a full arrival. It is the companion example to
[`../atc-runway-operations.md`](../atc-runway-operations.md): that note is the vocabulary, this is
the vocabulary in use on a real field. Every runway fact comes from [`runways.md`](runways.md); the
frequencies are the charted ones (`00067AD.PDF`).

Throughout, **▶ in the game** marks what the sim does today, and **⏳ pending** marks a beat that is
real procedure but not yet modelled — so the scenario doubles as a spec for what comes next.

BUR is the field for this because its two runways **cross** (08/26 × 15/33 at the surveyed
intersection), so a departure/arrival split is not two independent flows — every departure and every
arrival meets at one point of pavement. It is the case where designation and the crossing rule have
to work together.

---

## The configuration: land 8, depart 15

Burbank's predominant calm-wind flow lands the **ILS runway (08)** and departs the **longer runway
(15, 6,886 ft)** — a noise-and-performance split, and a textbook two-runway **departure/arrival**
configuration.

| Runway | Length | Role | Why |
|---|---|---|---|
| **08** | 5,802 ft | **arrivals** | the only ILS/MALSR/PAPI at the field; right traffic |
| **15** | 6,886 ft | **departures** | longer runway, better takeoff performance; the noise route |

**▶ Set it up in the game:** activate **RWY 08**, cycle its ops badge to **ARR**; activate **RWY
15**, cycle its badge to **DEP**. Both runways now show in the strip bay's configuration, one badge
green (ARR), one cyan (DEP). The spawner immediately splits: arrivals establish only on 08's final,
departures are generated only for 15.

**⏳ Pending — ATIS:** a real session opens with the recorded broadcast the split rides on:

> *"Hollywood Burbank information Alpha. 1655 Zulu. Wind 240 at 6. Visibility 10, sky clear.
> Altimeter 29.94. **Landing runway 8, departing runway 15.** ILS runway 8 approach in use. Advise
> on initial contact you have information Alpha."*

The game shows the configuration on the scope but does not yet *say* it (no ATIS letter, no wind —
[`../atc-runway-operations.md`](../atc-runway-operations.md) §9).

---

## A departure — SWA1234 off runway 15

1. **Clearance & pushback (Ground, 123.9).** SWA1234 at the terminal is delivered its clearance and
   a squawk, services complete, pushes back, and taxis. **▶** All standard Ground work.
2. **Taxi to 15, and the first crossing.** The SE terminal sits across the field from 15's threshold,
   so the taxi route **crosses runway 08** — the arrival runway — on the way. Ground does not embed
   the crossing in the taxi clearance; the route is split at the hold line:
   > Ground: *"Southwest 1234, runway 15 via… hold short of runway 8."* **▶**
   The crossing is its own clearance because 08 has landing traffic — *"cross runway 8"* is issued
   only when 08's final is clear (`crossRunway`, gated on the runway-clear predicate). **▶**
3. **Hold short of 15, contact Tower (118.7).** At 15's hold line SWA1234 is handed to Local Control.
4. **Line up and wait — the intersection bites.** 15 crosses 08 at the surveyed intersection (66% /
   79% along). An arrival on 08's final is committed to that shared point, so a takeoff on 15 that
   would roll through it is held:
   > Tower: *"Southwest 1234, runway 15, line up and wait, traffic landing runway 8."* **▶**
   The clearance to *line up* is allowed (the aircraft waits at its own threshold, clear of the
   crossing); the clearance to *roll* waits until the arrival is through — the **position-aware
   crossing** rule (`docs/atc-multi-runway.md` §6). **▶**
5. **Cleared for takeoff.** The 08 arrival crosses the intersection and rolls out clear:
   > Tower: *"Southwest 1234, runway 15, cleared for takeoff."* **▶**
   SWA1234 rolls, uses the full 6,886 ft, and departs. Because 15 is designated **departures-only**,
   Tower would refuse a landing clearance on it — *"RWY 15 is arrivals only"* is the inverse
   refusal, and neither can be issued on the wrong-designation runway. **▶**

---

## An arrival — AAL567 onto runway 8

1. **On final (Tower, 118.7).** AAL567 is established on 08's ILS. Because 08 is **arrivals-only**,
   the landing clearance is available and a *takeoff* clearance on 08 is refused (*"RWY 8 is arrivals
   only"*). **▶**
2. **Sequencing across the departures.** Every 15 departure crosses 08's rollout path, and every 08
   arrival crosses 15's departure path — one intersection, both flows. Tower times the 15 departures
   into the gaps between 08 arrivals. **▶** (The gap judgement is the controller's; the sim enforces
   only that no clearance puts two aircraft in conflict at the crossing.)
3. **Cleared to land.**
   > Tower: *"American 567, runway 8, cleared to land."* **▶**
   AAL567 touches down, rolls out, and picks a turnoff.
4. **Off the runway, back to Ground — and the second crossing.** AAL567's gate is on the far side of
   15, so its taxi in **crosses runway 15** — the departure runway. Tower hands it to Ground once
   clear of 08; Ground holds it short of 15 and clears it across in a gap between departures:
   > Ground: *"American 567, cross runway 15, then to the gate."* **▶** (`crossRunway`, one runway at
   a time.)

The two flows mirror each other: a departure crosses the arrival runway on the way *out*, an arrival
crosses the departure runway on the way *in*, and the single intersection is the pressure point the
whole configuration is organised around.

---

## The wind shifts — a configuration change

Mid-session the wind swings to the northwest and freshens past the tailwind limit for the 08/15
flow. The field turns around to the reciprocal ends: **land 33 / depart 26** (or, in lighter
traffic, a single runway both ways).

**▶ In the game:** cycle **RWY 08 → 26** and **RWY 15 → 33**. Turning a runway end-for-end **keeps
its designation** — 08-arrivals becomes 26-arrivals, 15-departures becomes 33-departures — so the
split survives the change; only the directions flip. The cascade fires on each:

- arrivals still on 08's final **go around and re-establish** on the new approach; landing clearances
  are voided;
- departures not yet rolling are **re-aimed** at the new departure end and Ground taxis them round;
- the change is **refused** while anything is committed to the runway being turned (on it, on short
  final, or rolling out) — a jet at 130 kt finishes first.

**⏳ Pending — the broadcast.** A real turnaround is announced to everyone at once:

> Tower (all frequencies): *"Attention all aircraft, Burbank is now landing runway 33, departing
> runway 26, wind shift. Acknowledge."*

The game performs the cascade but does not yet make the broadcast or take acknowledgements
([`../atc-runway-operations.md`](../atc-runway-operations.md) §9).

---

## What this scenario exercises

| Beat | Feature | State |
|---|---|---|
| Land 8 / depart 15 split | runway **operations designation** (arrivals / departures) | ✅ shipped |
| Refusing a landing on 15 / a takeoff on 8 | the designation clearance gates | ✅ shipped |
| Holding a 15 takeoff for an 8 arrival at the crossing | **position-aware crossing** (`atc-multi-runway.md` §6) | ✅ shipped |
| Taxi crossing the *other* runway, one clearance each way | **one-runway-at-a-time crossing** (`atc-runway-crossing.md` §6) | ✅ shipped |
| Turnaround keeps the designation, cascades the change | `setRunway` cascade + designation persistence | ✅ shipped |
| ATIS letter, wind driving the choice, the "attention all aircraft" broadcast | ATIS / wind / config-change broadcast | ⏳ pending (`atc-runway-operations.md` §9) |

The scenario is deliberately at BUR, where the two runways cross: it is the field where designation
and crossing are the same problem, and where the split configuration is a real operational choice
rather than a convenience.
