import { useRef } from 'react'
import { createGroundController, trafficLevelFor, type GroundController } from './controller'
import { GroundScope } from './GroundScope'
import { StripBay } from './StripBay'
import { loadTrafficRate } from './prefs'

/** The ground controller position: the surface scope plus the flight-strip bay,
 *  sharing one controller (sim + selection). */
export function Ground() {
  const ref = useRef<GroundController | null>(null)
  // Dev/admin sandbox: `?dev` (any value) starts an empty surface with the spawn/probe tools.
  // The traffic level survives a reload — play-testing means reloading constantly, and having
  // to turn the traffic back down every time is most of the reason to leave it up.
  // Only a rate the toolbar can show: a restored value the buttons don't offer would run the
  // field at a level nothing on screen is pressed for.
  const savedTraffic = loadTrafficRate()
  const startLevel = savedTraffic === undefined ? undefined : trafficLevelFor(savedTraffic)
  ref.current ??= createGroundController({
    dev: new URLSearchParams(window.location.search).has('dev'),
    ...(startLevel ? { trafficRate: startLevel.rate } : {}),
  })
  const controller = ref.current

  return (
    <div className="ground">
      <GroundScope controller={controller} />
      <StripBay controller={controller} />
    </div>
  )
}
