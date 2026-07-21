import {
  KSAN_SURFACE,
  buildKsanGroundGame,
  buildRunwayGuard,
  buildTaxiGraph,
  createGroundSim,
} from '@anotheratc/sim'
import type {
  ControllerPosition,
  GroundCommand,
  GroundIntent,
  GroundSim,
  GroundStatus,
  NamedDestination,
  Point,
  ServiceProgress,
  TaxiTopology,
  WakeCategory,
} from '@anotheratc/sim'

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
  /** Named taxiways the current route follows, in order (e.g. ["A","B"]). */
  via: string[]
  /** Callsign of the traffic this aircraft is giving way to, or null. */
  giveWayTo: string | null
  /** Assigned transponder code once cleared, or null. */
  squawk: string | null
  /** Seconds of wake-turbulence separation still owed before takeoff release; 0 when none. */
  wakeHoldSec: number
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
}

export interface StripSnapshot {
  aircraft: StripItem[]
  selectedId: string | null
  /** The route being built for the selected aircraft, if route mode is active. */
  draft: RouteDraft | null
}

/**
 * Owns the ground simulation and the selection, and bridges it to React: the
 * canvas drives `sim`/`select`/`dispatch` on its own loop and calls `publish()`
 * each frame; `subscribe`/`getSnapshot` feed the strip bay via useSyncExternalStore,
 * which only re-renders when the strip signature (id:status per aircraft + selection)
 * actually changes.
 */
export interface GroundController {
  readonly sim: GroundSim
  readonly destinations: NamedDestination[]
  /** The contracted routing graph (decision nodes + geometry edges) for the admin overlay. */
  readonly topology: TaxiTopology
  /** Whether the dev/admin sandbox is active (empty surface + spawn/probe tools). */
  readonly dev: boolean
  selectedId(): string | null
  select(id: string | null): void
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
  /** Remove the selected aircraft, if any. */
  removeSelected(): void
  /** Remove every aircraft from the surface. */
  clearAll(): void
  /** The active routing probe (or null). First click sets the origin, second routes to it. */
  probe(): ProbeResult | null
  /** Feed a click into the probe: set the origin, then route to the destination. */
  probeClick(point: Point): void
  /** Discard the active probe. */
  clearProbe(): void
}

export function createGroundController(opts: GroundControllerOptions = {}): GroundController {
  const dev = opts.dev ?? false
  const graph = buildTaxiGraph(KSAN_SURFACE)
  const topology = graph.topology()
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const game = buildKsanGroundGame(1)
  const { destinations } = game
  // Dev mode starts empty: no seeded aircraft, no auto-spawner, no servicing gate.
  const sim = dev
    ? createGroundSim([], { graph, guard })
    : createGroundSim(game.inits, { graph, guard, spawn: game.spawn, servicing: game.servicing })

  let selected: string | null = null
  let draft: RouteDraft | null = null
  let devSeq = 0
  let probeState: ProbeResult | null = null

  // Gate stands aren't routing nodes (they sit off the taxiway network), so include them as
  // snap targets — otherwise a click on a gate jumps to the nearest taxiway node instead.
  const gatePoints: { ref: string; point: Point }[] = KSAN_SURFACE.features
    .filter((f) => f.kind === 'gate' && f.ref && f.points[0])
    .map((f) => ({ ref: f.ref as string, point: f.points[0] as Point }))
  const dist2 = (a: Point, b: Point): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

  /** Nearest placeable spot to a world point: a routing node or a gate stand, whichever is
   *  closer. `gate` is set when the spot is a gate. Falls back to the point itself. */
  const nearestPlace = (p: Point): { point: Point; gate: string | null } => {
    const k = graph.nearestNode(p)
    const nodePt = k ? graph.nodePoint(k) : undefined
    let best: { point: Point; gate: string | null; d: number } | null = nodePt
      ? { point: nodePt, gate: null, d: dist2(nodePt, p) }
      : null
    for (const g of gatePoints) {
      const d = dist2(g.point, p)
      if (!best || d < best.d) best = { point: g.point, gate: g.ref, d }
    }
    return best ? { point: best.point, gate: best.gate } : { point: p, gate: null }
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
  let snapshot: StripSnapshot = { aircraft: [], selectedId: null, draft: null }
  let sig = ''

  /** How long a refusal/error message stays on the HUD (ms). */
  const NOTICE_MS = 4000
  let activeNotice: { message: string; until: number } | null = null
  const flashNotice = (message: string): void => {
    activeNotice = { message, until: performance.now() + NOTICE_MS }
  }

  const publish = (): void => {
    const acs = sim.snapshot().aircraft
    const vias = new Map(acs.map((a) => [a.id, sim.taxiwaysOf(a.id)]))
    let nextSig = selected ?? '-'
    nextSig += draft ? `~${draft.id}:${draft.via.join('.')}` : ''
    for (const a of acs)
      nextSig += `|${a.id}:${a.status}:${a.controlledBy}:${vias.get(a.id)!.join('.')}:${a.giveWayTo ?? ''}:${a.squawk ?? ''}:${a.wakeHoldSec}:${a.serviceSec}`
    if (nextSig === sig) return
    sig = nextSig
    snapshot = {
      selectedId: selected,
      draft: draft ? { id: draft.id, via: [...draft.via] } : null,
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
        via: vias.get(a.id)!,
        giveWayTo: a.giveWayTo,
        squawk: a.squawk,
        wakeHoldSec: a.wakeHoldSec,
        services: a.services,
        serviceSec: a.serviceSec,
      })),
    }
    for (const cb of listeners) cb()
  }

  publish() // seed the initial snapshot

  return {
    sim,
    destinations,
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
        type: 'B738',
        wake: 'M' as const,
        path: [place.point],
        targetSpeed: 0,
        intent: 'departure' as const,
      }
      sim.add(place.gate ? { ...base, gate: place.gate } : base)
      selected = id
      publish()
    },
    removeSelected: () => {
      if (!selected) return
      sim.remove(selected)
      selected = null
      draft = null
      publish()
    },
    clearAll: () => {
      sim.clear()
      selected = null
      draft = null
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
    clearProbe: () => {
      probeState = null
    },
    selectedId: () => selected,
    select: (id) => {
      selected = id
      if (draft && draft.id !== id) draft = null // route mode is bound to its aircraft
      publish()
    },
    dispatch: (cmd) => {
      try {
        const result = sim.dispatch(cmd)
        if (!result.ok) flashNotice(result.reason)
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
