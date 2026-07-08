import { useRef } from 'react'
import { createGroundController, type GroundController } from './controller'
import { GroundScope } from './GroundScope'
import { StripBay } from './StripBay'

/** The ground controller position: the surface scope plus the flight-strip bay,
 *  sharing one controller (sim + selection). */
export function Ground() {
  const ref = useRef<GroundController | null>(null)
  // Dev/admin sandbox: `?dev` (any value) starts an empty surface with the spawn/probe tools.
  ref.current ??= createGroundController({ dev: new URLSearchParams(window.location.search).has('dev') })
  const controller = ref.current

  return (
    <div className="ground">
      <GroundScope controller={controller} />
      <StripBay controller={controller} />
    </div>
  )
}
