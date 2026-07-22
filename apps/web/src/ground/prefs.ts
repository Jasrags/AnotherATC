/**
 * Small, boring persistence for controller preferences.
 *
 * Only the traffic level so far, and it is here rather than in the controller because the sim
 * side has no business knowing about a browser: the controller takes a starting rate, this
 * decides where that number was last written down.
 */
const TRAFFIC_RATE_KEY = 'atc.trafficRate'

/** The saved traffic rate, or undefined when there isn't a usable one. Storage is a boundary:
 *  the value can be absent, garbage, or unreadable (private mode, disabled cookies).
 *
 *  `globalThis.localStorage` is read *inside* the try, not as a parameter default: in a
 *  sandboxed frame the accessor itself throws, and a default is evaluated before the try
 *  block — which would put the exception on the render path this is meant to protect. */
export function loadTrafficRate(store?: Storage): number | undefined {
  try {
    const raw = (store ?? globalThis.localStorage)?.getItem(TRAFFIC_RATE_KEY)
    if (raw === null || raw === undefined) return undefined
    const rate = Number(raw)
    return Number.isFinite(rate) && rate >= 0 ? rate : undefined
  } catch {
    return undefined
  }
}

/** Remember the traffic rate for the next session. A storage failure is not worth a broken
 *  scope, so it is swallowed — the setting still applies to the running game. */
export function saveTrafficRate(rate: number, store?: Storage): void {
  try {
    ;(store ?? globalThis.localStorage)?.setItem(TRAFFIC_RATE_KEY, String(rate))
  } catch {
    // Persistence is a convenience; the session continues without it.
  }
}
