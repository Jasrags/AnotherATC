import { useRef } from 'react'
import { createGroundController, type GroundController } from './controller'
import { GroundScope } from './GroundScope'
import { StripBay } from './StripBay'

/** The ground controller position: the surface scope plus the flight-strip bay,
 *  sharing one controller (sim + selection). */
export function Ground() {
  const ref = useRef<GroundController | null>(null)
  ref.current ??= createGroundController()
  const controller = ref.current

  return (
    <div className="ground">
      <GroundScope controller={controller} />
      <StripBay controller={controller} />
    </div>
  )
}
