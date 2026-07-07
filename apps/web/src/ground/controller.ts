import {
  KSAN_SURFACE,
  buildKsanGroundGame,
  buildRunwayGuard,
  buildTaxiGraph,
  createGroundSim,
} from '@anotheratc/sim'
import type {
  GroundCommand,
  GroundIntent,
  GroundSim,
  GroundStatus,
  NamedDestination,
  Point,
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
  intent: GroundIntent
  gate: string | null
  /** Named taxiways the current route follows, in order (e.g. ["A","B"]). */
  via: string[]
  /** Callsign of the traffic this aircraft is giving way to, or null. */
  giveWayTo: string | null
  /** Assigned transponder code once cleared, or null. */
  squawk: string | null
}

/** An in-progress "taxi via …" clearance the controller is assembling by taxiway clicks. */
export interface RouteDraft {
  id: string
  via: string[]
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
}

export function createGroundController(): GroundController {
  const graph = buildTaxiGraph(KSAN_SURFACE)
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const { inits, spawn, destinations } = buildKsanGroundGame(1)
  const sim = createGroundSim(inits, { graph, guard, spawn })

  let selected: string | null = null
  let draft: RouteDraft | null = null
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
      nextSig += `|${a.id}:${a.status}:${vias.get(a.id)!.join('.')}:${a.giveWayTo ?? ''}:${a.squawk ?? ''}`
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
        intent: a.intent,
        gate: a.gate,
        via: vias.get(a.id)!,
        giveWayTo: a.giveWayTo,
        squawk: a.squawk,
      })),
    }
    for (const cb of listeners) cb()
  }

  publish() // seed the initial snapshot

  return {
    sim,
    destinations,
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
