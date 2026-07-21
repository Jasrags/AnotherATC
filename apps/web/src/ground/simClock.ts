/** Fixed simulation timestep (seconds) — decoupled from the render framerate. */
export const FIXED_DT = 0.05

/** Longest run of real time a single frame may account for. This is the "the tab was in the
 *  background" guard: without it, refocusing after a minute would replay that minute at once. */
const MAX_FRAME_SEC = 0.25

/** Most fixed steps one frame may run, so a slow frame can't spiral into a longer one. */
const MAX_STEPS = 30

export interface ClockTick {
  /** How many fixed steps to run this frame. */
  steps: number
  /** Time carried into the next frame. */
  acc: number
}

/**
 * Turn elapsed real time into a whole number of fixed simulation steps.
 *
 * `speed` scales simulated time, not the frame budget: the background clamp is applied to *real*
 * elapsed time first, before the multiplier, or refocusing a 4× session would fast-forward four
 * times as far as a 1× one. `speed: 0` is paused — nothing accumulates, so nothing steps, while
 * the rest of the app carries on rendering and accepting clearances.
 */
export function tick(acc: number, realDt: number, speed: number): ClockTick {
  const elapsed = Math.min(Math.max(realDt, 0), MAX_FRAME_SEC)
  const total = acc + elapsed * Math.max(speed, 0)
  // Divide rather than subtract in a loop: FIXED_DT is not exact in binary, so twenty
  // subtractions of 0.05 from 1.0 leave a hair less than zero and lose a step.
  let steps = Math.floor(total / FIXED_DT + 1e-9)
  let carry = total - steps * FIXED_DT
  // At the step cap, drop the backlog rather than carrying it: holding it would make the next
  // frames run long too, turning one slow frame into a lasting speed-up.
  if (steps > MAX_STEPS) {
    steps = MAX_STEPS
    carry = 0
  }
  return { steps, acc: Math.max(carry, 0) }
}
