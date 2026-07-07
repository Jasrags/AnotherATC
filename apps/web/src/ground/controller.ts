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
}

export interface StripSnapshot {
  aircraft: StripItem[]
  selectedId: string | null
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
  selectedId(): string | null
  select(id: string | null): void
  dispatch(cmd: GroundCommand): void
  routeOf(id: string): Point[]
  publish(): void
  subscribe(cb: () => void): () => void
  getSnapshot(): StripSnapshot
}

export function createGroundController(): GroundController {
  const graph = buildTaxiGraph(KSAN_SURFACE)
  const guard = buildRunwayGuard(KSAN_SURFACE)
  const { inits, spawn } = buildKsanGroundGame(1)
  const sim = createGroundSim(inits, { graph, guard, spawn })

  let selected: string | null = null
  const listeners = new Set<() => void>()
  let snapshot: StripSnapshot = { aircraft: [], selectedId: null }
  let sig = ''

  const publish = (): void => {
    const acs = sim.snapshot().aircraft
    let nextSig = selected ?? '-'
    for (const a of acs) nextSig += `|${a.id}:${a.status}`
    if (nextSig === sig) return
    sig = nextSig
    snapshot = {
      selectedId: selected,
      aircraft: acs.map((a) => ({
        id: a.id,
        callsign: a.callsign,
        type: a.type,
        wake: a.wake,
        status: a.status,
        intent: a.intent,
        gate: a.gate,
      })),
    }
    for (const cb of listeners) cb()
  }

  publish() // seed the initial snapshot

  return {
    sim,
    selectedId: () => selected,
    select: (id) => {
      selected = id
      publish()
    },
    dispatch: (cmd) => {
      sim.dispatch(cmd)
      publish()
    },
    routeOf: (id) => sim.routeOf(id),
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
