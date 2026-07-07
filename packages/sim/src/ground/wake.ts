import type { WakeCategory } from './types'

/**
 * Wake-turbulence separation for successive departures from the same runway — the
 * mandatory time (seconds) a following aircraft must wait behind the previous departure's
 * takeoff roll before it may begin its own. Only Heavy (H) and Super (J) leaders impose a
 * gap ("hard constraint behind Heavy/Super"). Values are real-world seconds; scale the
 * applied gate with WAKE_TIME_SCALE to tune feel. See docs/wake-turbulence.md (SIM-2),
 * grounded in FAA AC 90-23G / Order 7110.65 and ICAO Doc 4444.
 */
const WAKE_SEP_SEC: Readonly<Record<WakeCategory, Readonly<Record<WakeCategory, number>>>> = {
  J: { L: 180, M: 180, H: 120, J: 90 }, // Super leader
  H: { L: 120, M: 120, H: 90, J: 0 }, // Heavy leader
  M: { L: 0, M: 0, H: 0, J: 0 }, // Medium leader — no wake gate
  L: { L: 0, M: 0, H: 0, J: 0 }, // Light leader — no wake gate
}

/** Multiplier applied to the raw matrix at the release gate; 1.0 = real-world seconds. */
export const WAKE_TIME_SCALE = 1

/** Raw wake-separation minimum (seconds) for a follower departing behind a leader. */
export function wakeSeparationSec(leader: WakeCategory, follower: WakeCategory): number {
  return WAKE_SEP_SEC[leader][follower]
}
