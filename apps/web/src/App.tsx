import { KSAN, KBUR, KOAK, type Airport } from '@anotheratc/sim'
import { Ground } from './ground/Ground'
import { TerminalScope } from './terminal/TerminalScope'

/** The fields the app can run, keyed by ICAO. Pick one with `?airport=KBUR`; defaults to KSAN. */
const AIRPORTS: Record<string, Airport> = { KSAN, KBUR, KOAK }

/** The field named by `?airport=` (case-insensitive), or KSAN when absent/unknown. */
function airportFromUrl(): Airport {
  const id = new URLSearchParams(window.location.search).get('airport')
  return (id && AIRPORTS[id.toUpperCase()]) || KSAN
}

/**
 * Top-level mode switch. `?mode=tracon` opens the terminal radar scope; anything else is the
 * ground/tower surface scope (the default). The two controller modes are separate displays
 * (docs/atc-tracon.md §2) — a URL flag is enough to reach each while TRACON is being built.
 */
export function App() {
  const mode = new URLSearchParams(window.location.search).get('mode')?.toLowerCase()
  if (mode === 'tracon') return <TerminalScope airport={airportFromUrl()} />
  return <Ground />
}
