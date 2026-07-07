import { describe, it, expect } from 'vitest'
import { wakeSeparationSec, WAKE_TIME_SCALE } from './wake'

describe('wakeSeparationSec (departure wake matrix, seconds)', () => {
  it('imposes the largest gaps behind a Super (J)', () => {
    expect(wakeSeparationSec('J', 'L')).toBe(180)
    expect(wakeSeparationSec('J', 'M')).toBe(180)
    expect(wakeSeparationSec('J', 'H')).toBe(120)
    expect(wakeSeparationSec('J', 'J')).toBe(90)
  })

  it('imposes a gap behind a Heavy (H) for lighter followers, none for a Super follower', () => {
    expect(wakeSeparationSec('H', 'L')).toBe(120)
    expect(wakeSeparationSec('H', 'M')).toBe(120)
    expect(wakeSeparationSec('H', 'H')).toBe(90)
    expect(wakeSeparationSec('H', 'J')).toBe(0)
  })

  it('imposes no wake gate behind Medium or Light leaders', () => {
    for (const f of ['L', 'M', 'H', 'J'] as const) {
      expect(wakeSeparationSec('M', f)).toBe(0)
      expect(wakeSeparationSec('L', f)).toBe(0)
    }
  })

  it('defaults the time scale to 1.0 (real-world seconds)', () => {
    expect(WAKE_TIME_SCALE).toBe(1)
  })
})
