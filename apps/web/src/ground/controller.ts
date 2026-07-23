import {
  KSAN,
  buildRunwayGuard,
  buildRunwayIntersections,
  buildTaxiGraph,
  createAirportGame,
  createGroundSim,
  EDCT_EARLY_SEC,
  findRunway,
  lookupAircraftType,
} from '@anotheratc/sim'
import type {
  Airport,
  ApproachConfig,
  ControllerPosition,
  GroundCommand,
  GroundIntent,
  GroundSim,
  GroundStatus,
  NamedDestination,
  Point,
  PushbackOption,
  RunwayExit,
  ServiceProgress,
  StandOption,
  TaxiTopology,
  Transmission,
  WakeCategory,
} from '@anotheratc/sim'

/** How many alternative stands the reassign menu offers. The field has 51; the nearest handful
 *  is a decision, the whole list is just a list. */
const STAND_MENU_LIMIT = 6

/** How far apart (nm) successive dev-spawned test arrivals sit along the final. */
const DEV_ARRIVAL_SPACING_NM = 1.2

/**
 * The traffic levels the controller offers, as multipliers on the field's own configured rate.
 *
 * A rate rather than an aircraft count: how busy a field is at "moderate" is a property of the
 * field (KSAN's single runway is not KLAX's four), so the levels scale what the airport data
 * already states instead of overriding it. LOW exists for play-testing one mechanic at a time
 * without the surface filling up behind you; OFF leaves you exactly the traffic already there.
 */
export const TRAFFIC_LEVELS = [
  { label: 'OFF', rate: 0 },
  { label: 'LOW', rate: 0.35 },
  { label: 'MOD', rate: 1 },
  { label: 'HIGH', rate: 1.75 },
] as const

/** The level a rate corresponds to, or undefined for a rate no button offers. The toolbar shows
 *  a rate by pressing its button, so a rate outside this list would run with nothing pressed —
 *  which is why a restored rate is checked against it rather than trusted. */
export function trafficLevelFor(rate: number): (typeof TRAFFIC_LEVELS)[number] | undefined {
  return TRAFFIC_LEVELS.find((l) => l.rate === rate)
}

/**
 * Read-back errors: how often a pilot mishears the beacon code in an IFR clearance, and the
 * seed that makes it reproducible.
 *
 * Held off until the base loop was proven, on the grounds that a mechanic making clearances
 * silently take effect wrong is exactly what hides a real bug behind "the pilot misheard it".
 * That is why it is *this* rate: about one clearance in seven, which is far more often than
 * real life and often enough that a session contains a few — and why the error has one
 * consequence rather than many, at the Tower handoff, where the refusal names itself. A bug
 * that looks like a mishearing still has one place to hide, and that place says so out loud.
 *
 * Its own stream, so turning it on does not shift the spawner's traffic by a single aircraft.
 */
const READBACK = { errorRate: 0.15, seed: 7919 }

/** What a flight strip shows — deliberately excludes fast-changing fields (position,
 *  speed) so the strip bay only re-renders when phase or selection changes. */
export interface StripItem {
  id: string
  callsign: string
  type: string
  wake: WakeCategory
  status: GroundStatus
  /** Which controller owns the aircraft: Ground, or Tower after a handoff. Gates whether the
   *  strip offers Ground actions (Contact tower) or Tower actions (line up, cleared for takeoff). */
  controlledBy: ControllerPosition
  intent: GroundIntent
  gate: string | null
  /** Holding short of its own departure runway (offer Contact tower) vs. to cross (offer
   *  Cross runway). Only meaningful when status is 'holdShort'. */
  holdingForTakeoff: boolean
  /** Physically on the runway surface right now (line-up, takeoff roll, or crossing). */
  onRunway: boolean
  /** Occupies the runway in a way that blocks another aircraft's takeoff clearance (any
   *  on-runway aircraft except a departure that has rotated). Gates the takeoff-clearance UI. */
  blocksTakeoff: boolean
  /** Designator of the runway turnoff this arrival is planning for / rolling out to, or null. */
  exitRef: string | null
  /** Turnoffs this arrival could still be assigned. Published with the rest of the strip rather
   *  than queried from the sim at render time: the command menu must be built from the same
   *  instant as the numbers printed above it, or the two disagree on a fast final. */
  exitOptions: readonly RunwayExit[]
  /** The ways this aircraft can be pushed back off its stand. Published for the same reason as
   *  `exitOptions`, though these are static per stand: the menu reads one snapshot, never the
   *  live sim. Empty for anything that isn't a parked departure. */
  pushbackOptions: readonly PushbackOption[]
  /** Landed and fully clear of the runway — ready to be handed to Ground. */
  vacated: boolean
  /** Tower has already issued the frequency change; it applies when the aircraft vacates. */
  handoffPending: boolean
  /** On final and close enough in to own the runway. Comes straight from the sim's own
   *  predicate — never re-derived here from `finalNm`, which is rounded for display and
   *  would disagree with the sim near the threshold distance. */
  onShortFinal: boolean
  /** Height above the field in feet, rounded for display; 0 on the surface. */
  altitude: number
  /** Distance (nm) still to fly to the landing threshold, to 0.1 nm; 0 unless on final. */
  finalNm: number
  /** Named taxiways the current route follows, in order (e.g. ["A","B"]). */
  via: string[]
  /** Callsign of the traffic this aircraft is giving way to, or null. */
  giveWayTo: string | null
  /** Callsign of the landing traffic a conditional line-up is waiting for, or null — a clearance
   *  that has been issued and has not happened yet. */
  lineUpBehind: string | null
  /** Named in a runway incursion — on the runway uncleared, or sharing it with traffic that is
   *  landing, lining up or rolling. Drives the "clear the runway" framing on its menu. */
  incursion: boolean
  /** Already running its clearance at expedite speed. */
  expedite: boolean
  /** Has route left to run, so "expedite" has something to act on. The sim's own guard. */
  canExpedite: boolean
  /** A "hold short of runway N" would be accepted — there is a runway ahead to hold short of. */
  canHoldShort: boolean
  /** Stand this aircraft is waiting on because someone is still parked there, or null. */
  waitingForStand: string | null
  /** For an inbound arrival not yet parked: its destination stand is already occupied by someone
   *  else — a gate conflict in the making, shown before the aircraft ever gets there. Straight
   *  from the sim's own `gateBlocked`, so the strip and the field-wide alert can't disagree. */
  destStandOccupied: boolean
  /** Free stands this arrival could be sent to instead, nearest first. Published like the other
   *  menu inputs so the command list is built from one snapshot, never a live sim query. */
  standOptions: readonly StandOption[]
  /** The code the aircraft is squawking — not necessarily the one issued, if the pilot
   *  misheard the clearance. */
  squawk: string | null
  /** Something has been transmitted to this aircraft, so "say again" has a clearance to
   *  repeat. */
  hasInstruction: boolean
  /** Seconds of wake-turbulence separation still owed before takeoff release; 0 when none. */
  wakeHoldSec: number
  /** Whole seconds this aircraft has been stopped with nothing to run — waiting on *you*, not
   *  on traffic or a gate. 0 when it isn't. Drives the strip's clock and the HUD advisory. */
  awaitingSec: number
  /** Sim time (s) this departure must be airborne at — its wheels-up slot — or null. */
  edctSec: number | null
  /** Seconds until that slot's window opens: 0 once it is open, negative once it has passed.
   *  Derived at publish time so the strip has a countdown without doing arithmetic on a clock
   *  it does not hold. */
  edctInSec: number
  /** Parallel ground services still running before pushback unlocks; empty when ready/none. */
  services: readonly ServiceProgress[]
  /** Seconds until the long-pole service finishes and pushback unlocks; 0 when ready/none. */
  serviceSec: number
}

/** An in-progress "taxi via …" clearance the controller is assembling by taxiway clicks. */
export interface RouteDraft {
  id: string
  via: string[]
}

/** A dev-mode routing probe: the shortest graph path between two clicked points, for
 *  eyeballing taxiway routing without spawning. `to`/`path` are null/empty until the
 *  second click; an empty `path` after the second click means no route was found. */
export interface ProbeResult {
  from: Point
  to: Point | null
  path: Point[]
  taxiways: string[]
  lengthNm: number
}

/** Options for the controller. `dev` starts an empty surface (no seeded aircraft, spawner
 *  off) and unlocks the spawn/probe sandbox tools. */
export interface GroundControllerOptions {
  dev?: boolean
  /** Which field to run. Defaults to KSAN; anything satisfying `Airport` works, which is what
   *  keeps this layer free of airport specifics. */
  airport?: Airport
  /** Starting traffic level (see {@link TRAFFIC_LEVELS}). Omit for the field's own rate.
   *  Ignored in dev mode, which has no spawner at all. */
  trafficRate?: number
}

export interface StripSnapshot {
  aircraft: StripItem[]
  /** Designator of the runway direction in use. Published rather than mirrored in component
   *  state so it cannot drift from the sim, whatever changes it. */
  activeRunway: string
  selectedId: string | null
  /** The active controller position (which strip bay is shown). */
  position: ControllerPosition
  /** The route being built for the selected aircraft, if route mode is active. */
  draft: RouteDraft | null
  /** The radio transcript, oldest first. Straight from the sim — the UI never writes it. */
  comms: readonly Transmission[]
}

/**
 * Owns the ground simulation and the selection, and bridges it to React: the
 * canvas drives `sim`/`select`/`dispatch` on its own loop and calls `publish()`
 * each frame; `subscribe`/`getSnapshot` feed the strip bay via useSyncExternalStore,
 * which only re-renders when the strip signature (id:status per aircraft + selection)
 * actually changes.
 */
export interface GroundController {
  /** The field being run — surface, runways, comms, everything airport-specific. */
  readonly airport: Airport
  readonly sim: GroundSim
  readonly destinations: NamedDestination[]
  /** The final-approach geometry arrivals fly in on, so the scope can draw the course.
   *  Follows the active runway — it changes when the configuration does. */
  approach(): ApproachConfig
  /** Designator of the runway direction in use, e.g. "27". */
  activeRunway(): string
  /** Switch the airport configuration. Single runway: this moves *both* the arrival final and
   *  the departure end, because they are always the same direction. Refused (with a notice)
   *  while traffic is committed to the runway in use. */
  setRunway(ident: string): void
  /** The runway directions this field can be configured to, in display order. */
  runwayIdents(): string[]
  /** How much traffic the field is generating, as a multiplier on its configured rate
   *  (1 = as configured, 0 = none). See {@link TRAFFIC_LEVELS}. */
  trafficRate(): number
  /** Turn the traffic up or down. Takes effect on the next spawn interval; aircraft already
   *  on the surface stay — this changes what arrives, not what is being worked. */
  setTrafficRate(rate: number): void
  /** Every named taxiway where it meets the runway, ordered along the direction in use — the
   *  places a departure can be taxied to and hold short of for an intersection departure. */
  holdShortSpots(): NamedDestination[]
  /** Runway turnoffs this arrival could still be assigned (ahead of it and reachable).
   *  For the canvas only, which draws outside React's render cycle — anything rendered by
   *  React must use `StripItem.exitOptions` off the published snapshot instead. */
  exitOptions(id: string): RunwayExit[]
  /** The contracted routing graph (decision nodes + geometry edges) for the admin overlay. */
  readonly topology: TaxiTopology
  /** Whether the dev/admin sandbox is active (empty surface + spawn/probe tools). */
  readonly dev: boolean
  selectedId(): string | null
  select(id: string | null): void
  /** The active controller position (Ground or Tower). */
  position(): ControllerPosition
  /** Switch the active controller position (which strip bay is shown). */
  setPosition(p: ControllerPosition): void
  dispatch(cmd: GroundCommand): void
  /** A transient controller-facing message (a refused command or an error), or null.
   *  Expires a few seconds after it is set. */
  notice(): string | null
  routeOf(id: string): Point[]
  /** The route currently being assembled by taxiway clicks, or null. */
  routeDraft(): RouteDraft | null
  /** Enter route-building mode for an aircraft (starts an empty via-sequence). */
  beginRoute(id: string): void
  /** Append a taxiway designator to the active draft (ignores consecutive repeats). */
  addVia(ref: string): void
  /** Remove the taxiway at the given index from the active draft. */
  removeViaAt(index: number): void
  /** Discard the active draft. */
  clearRoute(): void
  publish(): void
  subscribe(cb: () => void): () => void
  getSnapshot(): StripSnapshot
  // ── Dev/admin sandbox ──────────────────────────────────────────────────────
  /** Snap a world point to the nearest routing node (for a placement preview), or null. */
  snap(point: Point): Point | null
  /** Place a test aircraft at the nearest routing node to `point` and select it. */
  spawnAt(point: Point): void
  /** Put a test arrival on the final approach, inbound to the landing runway, and select it.
   *  Airborne traffic can't be placed by clicking the surface, so it gets its own control. */
  spawnArrival(): void
  /** The ICAO designator the sandbox will spawn next (for both {@link spawnAt} and
   *  {@link spawnArrival}). */
  devType(): string
  /** Choose the airframe the sandbox spawns next. Unknown designators fall back to a Medium at
   *  spawn time via the catalog, so this never has to validate. */
  setDevType(designator: string): void
  /** The selectable spawn types, grouped by the field's own fleets, for the dev type picker.
   *  Fleet membership is an airport property, so it comes from the airport's fleets rather than
   *  the (airport-independent) type catalog. */
  spawnTypeGroups(): { kind: string; types: { designator: string; wake: WakeCategory }[] }[]
  /** Remove the selected aircraft, if any. */
  removeSelected(): void
  /** Remove a specific aircraft by id (for click-to-delete). Clears the selection if it was
   *  the one removed. */
  remove(id: string): void
  /** Remove every aircraft from the surface. */
  clearAll(): void
  /** The active routing probe (or null). First click sets the origin, second routes to it. */
  probe(): ProbeResult | null
  /** Feed a click into the probe: set the origin, then route to the destination. */
  probeClick(point: Point): void
  /** Discard the active probe. */
  clearProbe(): void
  /** Ask the scope to centre on an aircraft, keeping the current zoom. The canvas owns the
   *  view, so this is a request it picks up on its next frame — the same way FIT works. */
  focusOn(id: string): void
  /** Take the pending focus request, if any. Consuming it clears it. */
  takeFocus(): string | null
}

export function createGroundController(opts: GroundControllerOptions = {}): GroundController {
  const dev = opts.dev ?? false
  const airport = opts.airport ?? KSAN
  const graph = buildTaxiGraph(airport.surface)
  const topology = graph.topology()
  const guard = buildRunwayGuard(airport.surface)
  const game = createAirportGame(airport)
  const { destinations } = game
  // Dev mode starts empty: no seeded aircraft, no auto-spawner, no servicing gate.
  const frequencies = { ground: airport.comms.ground, tower: airport.comms.tower }
  // Charted hot spots come from the field's own surface data — the sim watches harder inside
  // them. Handed to the sandbox too: a hot spot is a property of the airport, not of the game
  // mode, and the sandbox is where you go to stage exactly the situation it warns about.
  const hotspots = airport.surface.hotspots ?? []
  const sim = dev
    ? createGroundSim([], { graph, guard, hotspots, runway: game.runway, frequencies, stands: game.stands })
    : createGroundSim(game.inits, {
        graph,
        guard,
        hotspots,
        spawn: game.spawn,
        servicing: game.servicing,
        runway: game.runway,
        frequencies,
        stands: game.stands,
        // Arrivals become the next departure off the same stand rather than vanishing, which is
        // what makes a gate a finite resource rather than a formality.
        turnaround: true,
        readback: READBACK,
        // Wheels-up windows, if this field's flow is constrained — the lead is the airport's
        // number, so it arrives with the game rather than being chosen here.
        ...(game.slots ? { slots: game.slots } : {}),
      })
  // A bad saved/URL value must not take the field down with it — fall back to the field's rate.
  if (opts.trafficRate !== undefined && Number.isFinite(opts.trafficRate) && opts.trafficRate >= 0) {
    sim.setTrafficRate(opts.trafficRate)
  }

  let selected: string | null = null
  let position: ControllerPosition = 'ground'
  let draft: RouteDraft | null = null
  let devSeq = 0
  let probeState: ProbeResult | null = null
  // Which airframe the dev sandbox spawns next — for both the click-to-place departure and the
  // ARRIVAL button. Defaults to the first designator any fleet flies (not just fleets[0]'s, so an
  // empty leading fleet can't seed a type the picker never renders), and only falls to a literal
  // if the field somehow flies nothing. Wake and approach speed come from the catalog, so
  // spawning a Heavy behaves like a Heavy.
  let devType = airport.fleets.flatMap((f) => f.types)[0] ?? 'B738'
  let pendingFocus: string | null = null

  // Gate stands aren't routing nodes (they sit off the taxiway network), so include them as
  // snap targets — otherwise a click on a gate jumps to the nearest taxiway node instead.
  // The target is the stand's *nose stop*, not the gate label node: an aircraft placed on the
  // label sits a plane's length off the paint, and its pushback then starts by sliding sideways
  // onto the lead-in instead of backing down it.
  const gatePoints: { ref: string; point: Point; headingDeg: number }[] = game.stands.map((s) => ({
    ref: s.ref,
    point: s.stop,
    headingDeg: s.headingDeg,
  }))
  const dist2 = (a: Point, b: Point): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

  /** Nearest placeable spot to a world point: a routing node or a gate stand, whichever is
   *  closer. `gate` is set when the spot is a gate. Falls back to the point itself. */
  const nearestPlace = (p: Point): { point: Point; gate: string | null; headingDeg?: number } => {
    const k = graph.nearestNode(p)
    const nodePt = k ? graph.nodePoint(k) : undefined
    let best: { point: Point; gate: string | null; headingDeg?: number; d: number } | null = nodePt
      ? { point: nodePt, gate: null, d: dist2(nodePt, p) }
      : null
    for (const g of gatePoints) {
      const d = dist2(g.point, p)
      if (!best || d < best.d) best = { point: g.point, gate: g.ref, headingDeg: g.headingDeg, d }
    }
    return best ? { point: best.point, gate: best.gate, ...(best.headingDeg !== undefined ? { headingDeg: best.headingDeg } : {}) } : { point: p, gate: null }
  }
  /** Nearest placeable spot's point (for the placement/probe preview), or null. */
  const snapPoint = (p: Point): Point | null => nearestPlace(p).point
  /** Named taxiways a node-point path traverses, in order (deduped). */
  const taxiwaysAlong = (pts: Point[]): string[] => {
    const out: string[] = []
    let prev: string | null = null
    for (const p of pts) {
      const k = graph.keyAt(p)
      if (!k) {
        prev = null
        continue
      }
      if (prev) {
        const ref = graph.refBetween(prev, k)
        if (ref && out[out.length - 1] !== ref) out.push(ref)
      }
      prev = k
    }
    return out
  }
  const listeners = new Set<() => void>()
  let snapshot: StripSnapshot = {
    aircraft: [],
    selectedId: null,
    position: 'ground',
    draft: null,
    activeRunway: game.runway.ident,
    comms: [],
  }
  let sig = ''

  /** How long a refusal/error message stays on the HUD (ms). */
  const NOTICE_MS = 4000
  let activeNotice: { message: string; until: number } | null = null
  const flashNotice = (message: string): void => {
    activeNotice = { message, until: performance.now() + NOTICE_MS }
  }

  const publish = (): void => {
    const simSnap = sim.snapshot()
    const acs = simSnap.aircraft
    const comms = simSnap.comms
    const vias = new Map(acs.map((a) => [a.id, sim.taxiwaysOf(a.id)]))
    // Only an arrival can be sent to a different stand, and only before it parks. Capped: the
    // field has 51 stands and a menu of all of them is not a decision, it is a list.
    const standOpts = new Map(
      acs
        .filter((a) => a.intent === 'arrival' && a.status !== 'parked')
        .map((a) => [a.id, sim.standOptions(a.id).slice(0, STAND_MENU_LIMIT)] as const),
    )
    // Only a parked departure on a stand can be pushed back; the options are fixed geometry.
    const pushOpts = new Map(
      acs
        .filter((a) => a.status === 'parked' && a.intent === 'departure' && a.gate !== null)
        .map((a) => [a.id, sim.pushbackOptions(a.id)] as const),
    )
    // Only a Tower arrival can be assigned a turnoff, so don't query the rest of the fleet.
    const exitOpts = new Map(
      acs
        .filter((a) => a.intent === 'arrival' && a.controlledBy === 'tower')
        .map((a) => [a.id, sim.exitOptions(a.id)] as const),
    )
    // The transcript only ever appends, so its last sequence number is a complete change key.
    let nextSig = `${position}|${selected ?? '-'}|${sim.runway()?.ident ?? '-'}|${comms.at(-1)?.seq ?? 0}`
    nextSig += draft ? `~${draft.id}:${draft.via.join('.')}` : ''
    // Range-to-threshold is continuous, so it enters the signature at display precision
    // (0.1 nm ≈ one re-render every ~2.5 s on final) rather than every frame.
    for (const a of acs)
      nextSig += `|${a.id}:${a.status}:${a.controlledBy}:${a.onRunway ? 'R' : ''}${a.blocksTakeoff ? 'B' : ''}${a.onShortFinal ? 'F' : ''}${a.vacated ? 'V' : ''}${a.handoffPending ? 'H' : ''}${a.incursion ? 'X' : ''}${a.expedite ? 'E' : ''}${a.canExpedite ? 'C' : ''}${a.canHoldShort ? 'S' : ''}:${a.exitRef ?? ''}:${(exitOpts.get(a.id) ?? []).map((e) => e.ref).join('+')}:${vias.get(a.id)!.join('.')}:${a.giveWayTo ?? ''}:${a.lineUpBehind ?? ''}:${a.waitingForStand ?? ''}:${a.gateBlocked ? 'O' : ''}:${a.squawk ?? ''}:${a.hasInstruction ? 'I' : ''}:${a.wakeHoldSec}:${a.awaitingSec}:${a.edctSec ?? ''}:${a.serviceSec}:${a.finalNm.toFixed(1)}`
    if (nextSig === sig) return
    sig = nextSig
    snapshot = {
      selectedId: selected,
      position,
      activeRunway: sim.runway()?.ident ?? game.runway.ident,
      draft: draft ? { id: draft.id, via: [...draft.via] } : null,
      comms,
      aircraft: acs.map((a) => ({
        id: a.id,
        callsign: a.callsign,
        type: a.type,
        wake: a.wake,
        status: a.status,
        controlledBy: a.controlledBy,
        intent: a.intent,
        gate: a.gate,
        holdingForTakeoff: a.holdingForTakeoff,
        onRunway: a.onRunway,
        blocksTakeoff: a.blocksTakeoff,
        onShortFinal: a.onShortFinal,
        exitRef: a.exitRef,
        exitOptions: exitOpts.get(a.id) ?? [],
        pushbackOptions: pushOpts.get(a.id) ?? [],
        vacated: a.vacated,
        handoffPending: a.handoffPending,
        altitude: Math.round(a.altitude / 50) * 50,
        finalNm: Math.round(a.finalNm * 10) / 10,
        via: vias.get(a.id)!,
        giveWayTo: a.giveWayTo,
        lineUpBehind: a.lineUpBehind,
        incursion: a.incursion,
        expedite: a.expedite,
        canExpedite: a.canExpedite,
        canHoldShort: a.canHoldShort,
        waitingForStand: a.waitingForStand,
        destStandOccupied: a.gateBlocked,
        standOptions: standOpts.get(a.id) ?? [],
        squawk: a.squawk,
        hasInstruction: a.hasInstruction,
        wakeHoldSec: a.wakeHoldSec,
        awaitingSec: a.awaitingSec,
        edctSec: a.edctSec,
        edctInSec: a.edctSec === null ? 0 : Math.ceil(a.edctSec - EDCT_EARLY_SEC - simSnap.time),
        services: a.services,
        serviceSec: a.serviceSec,
      })),
    }
    for (const cb of listeners) cb()
  }

  publish() // seed the initial snapshot

  return {
    airport,
    sim,
    destinations,
    approach: () => sim.approach() ?? game.spawn.approach,
    holdShortSpots: () => {
      const r = sim.runway() ?? game.runway
      return buildRunwayIntersections(topology, guard, r.departureStart, r.farEnd).map((i) => ({
        id: `hs-${i.ref}`,
        label: `RWY @ ${i.ref}`,
        kind: 'spot' as const,
        point: i.point,
      }))
    },
    trafficRate: () => sim.trafficRate(),
    setTrafficRate: (rate) => {
      sim.setTrafficRate(rate)
      const level = trafficLevelFor(rate)
      flashNotice(level ? `Traffic ${level.label}` : `Traffic rate ${rate}×`)
    },
    activeRunway: () => sim.runway()?.ident ?? game.runway.ident,
    runwayIdents: () => airport.runways.map((r) => r.ident),
    setRunway: (ident) => {
      const next = findRunway(airport, ident)
      if (!next) {
        flashNotice(`${airport.icao} has no runway ${ident}`)
        return
      }
      const res = sim.setRunway(next)
      // Announce either way. A successful change silently moves every arrival's final and every
      // departure's roll direction, so it needs saying as much as a refusal does — and the
      // notice lands in an aria-live region, which is the only announcement a screen reader gets.
      flashNotice(res.ok ? `RWY ${ident} now in use — arrivals and departures` : res.reason)
      publish()
    },
    exitOptions: (id) => sim.exitOptions(id),
    topology,
    dev,
    snap: snapPoint,
    spawnAt: (point) => {
      const place = nearestPlace(point)
      const id = `dev${devSeq}`
      devSeq += 1
      const base = {
        id,
        callsign: `DEV${String(devSeq).padStart(2, '0')}`,
        type: devType,
        wake: lookupAircraftType(devType).wake,
        path: [place.point],
        targetSpeed: 0,
        // Parked on a stand it faces the way the lead-in points, like any other gate departure.
        ...(place.headingDeg !== undefined ? { heading: place.headingDeg } : {}),
        intent: 'departure' as const,
        // Give it a departure-runway goal so it's a takeoff (not a crossing) when it holds
        // short — otherwise the Tower handoff / takeoff flow can't engage in the sandbox.
        // Follows the *active* runway, so a test aircraft spawned while 09 is in use aims at
        // 09's departure end rather than whichever end was configured at startup.
        ...(sim.runway() ? { goalPoint: sim.runway()!.departureStart } : {}),
      }
      sim.add(place.gate ? { ...base, gate: place.gate } : base)
      selected = id
      publish()
    },
    spawnArrival: () => {
      const id = `dev${devSeq}`
      devSeq += 1
      // Stagger successive test arrivals down the final so they don't stack on one point —
      // deterministic (driven by the spawn counter, not a clock or RNG).
      // The *active* runway's final, not whichever was configured at startup — otherwise a
      // test arrival keeps appearing on 27's approach after the airport has turned round.
      const { fix, threshold } = sim.approach() ?? game.spawn.approach
      const back = (devSeq - 1) * DEV_ARRIVAL_SPACING_NM
      const len = Math.hypot(fix[0] - threshold[0], fix[1] - threshold[1]) || 1
      const start: Point = [
        fix[0] + ((fix[0] - threshold[0]) / len) * back,
        fix[1] + ((fix[1] - threshold[1]) / len) * back,
      ]
      const stand = gatePoints[(devSeq - 1) % Math.max(1, gatePoints.length)]
      const spec = lookupAircraftType(devType)
      sim.add({
        id,
        callsign: `DEV${String(devSeq).padStart(2, '0')}`,
        type: devType,
        wake: spec.wake,
        path: [start, threshold],
        // Its own type's threshold speed, so a dev C172 and a dev B763 occupy the runway for
        // visibly different times — the capability the sim proves in a test, made watchable here.
        targetSpeed: spec.approachKt,
        airborne: true,
        intent: 'arrival',
        goalPoint: stand?.point ?? threshold,
        ...(stand ? { gate: stand.ref } : {}),
      })
      selected = id
      position = 'tower' // an arrival on final is Local Control's — show the bay that owns it
      publish()
    },
    devType: () => devType,
    setDevType: (designator) => {
      devType = designator
    },
    spawnTypeGroups: () =>
      airport.fleets
        // A fleet that flies nothing would render an empty <optgroup> and, if it led, could leave
        // the selected value with no matching option — so it never reaches the picker.
        .filter((f) => f.types.length > 0)
        .map((f) => ({
          kind: f.kind,
          types: f.types.map((designator) => ({ designator, wake: lookupAircraftType(designator).wake })),
        })),
    removeSelected: () => {
      if (!selected) return
      sim.remove(selected)
      selected = null
      draft = null
      publish()
    },
    remove: (id) => {
      if (!sim.remove(id)) return
      if (selected === id) {
        selected = null
        draft = null
      }
      publish()
    },
    clearAll: () => {
      sim.clear()
      selected = null
      draft = null
      probeState = null // the probe outlives the fleet otherwise, drawn over an empty surface
      publish()
    },
    probe: () => probeState,
    probeClick: (point) => {
      const at = snapPoint(point) ?? point
      if (!probeState || probeState.to) {
        probeState = { from: at, to: null, path: [], taxiways: [], lengthNm: 0 }
        return
      }
      const fromKey = graph.nearestNode(probeState.from)
      const toKey = graph.nearestNode(at)
      const path = fromKey && toKey ? graph.route(fromKey, toKey) : []
      let lengthNm = 0
      for (let i = 1; i < path.length; i += 1) {
        lengthNm += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1])
      }
      probeState = { from: probeState.from, to: at, path, taxiways: taxiwaysAlong(path), lengthNm }
    },
    focusOn: (id) => {
      pendingFocus = id
    },
    takeFocus: () => {
      const id = pendingFocus
      pendingFocus = null
      return id
    },
    clearProbe: () => {
      probeState = null
    },
    selectedId: () => selected,
    select: (id) => {
      selected = id
      if (draft && draft.id !== id) draft = null // route mode is bound to its aircraft
      publish()
    },
    position: () => position,
    setPosition: (p) => {
      position = p
      publish()
    },
    dispatch: (cmd) => {
      try {
        const result = sim.dispatch(cmd)
        if (!result.ok) flashNotice(result.reason)
        else if (cmd.type === 'contactTower') {
          // Follow the aircraft onto the Tower position so its takeoff clearance is right
          // there, and announce the hand-off (the transfer is otherwise silent).
          const cs = sim.snapshot().aircraft.find((a) => a.id === cmd.aircraftId)?.callsign
          position = 'tower'
          flashNotice(`${cs ?? cmd.aircraftId} → Tower`)
        }
      } catch (err) {
        // A command should never throw; if it does, don't let the click silently vanish.
        console.error('ground command failed', cmd, err)
        flashNotice('command failed — see console')
      }
      publish()
    },
    notice: () => {
      if (!activeNotice) return null
      if (performance.now() >= activeNotice.until) {
        activeNotice = null
        return null
      }
      return activeNotice.message
    },
    routeOf: (id) => sim.routeOf(id),
    routeDraft: () => draft,
    beginRoute: (id) => {
      draft = { id, via: [] }
      publish()
    },
    addVia: (ref) => {
      if (!draft || draft.via[draft.via.length - 1] === ref) return
      draft = { id: draft.id, via: [...draft.via, ref] }
      publish()
    },
    removeViaAt: (index) => {
      if (!draft || index < 0 || index >= draft.via.length) return
      draft = { id: draft.id, via: draft.via.filter((_, k) => k !== index) }
      publish()
    },
    clearRoute: () => {
      if (!draft) return
      draft = null
      publish()
    },
    publish,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    getSnapshot: () => snapshot,
  }
}
