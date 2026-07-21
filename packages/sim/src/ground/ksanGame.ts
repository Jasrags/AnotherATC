import { createAirportGame, type AirportGame } from '../world/airport'
import { KSAN } from '../world/ksanAirport'

export { KSAN_RUNWAYS, KSAN_RUNWAY_LAYOUT } from '../world/ksanAirport'

/**
 * The KSAN game. A thin wrapper over the generic {@link createAirportGame} — everything that
 * used to live here is now data on the `KSAN` airport, so the builder has no field-specific
 * knowledge left in it.
 */
export function buildKsanGroundGame(seed = 1, config: '09' | '27' = '27'): AirportGame {
  return createAirportGame(KSAN, seed, config)
}
