import { describe, expect, it } from 'vitest'
import type { Transmission } from '@anotheratc/sim'
import { clock, visibleComms } from './CommsLog'

const t = (over: Partial<Transmission> & { seq: number }): Transmission => ({
  time: 0,
  from: 'controller',
  position: 'ground',
  aircraftId: 'a',
  callsign: 'SKW412',
  text: 'x',
  ...over,
})

describe('clock', () => {
  it('formats simulated seconds as mm:ss', () => {
    expect(clock(0)).toBe('00:00')
    expect(clock(65)).toBe('01:05')
    expect(clock(3599.9)).toBe('59:59')
  })

  it('rolls past an hour rather than wrapping to zero', () => {
    expect(clock(3600)).toBe('60:00')
  })
})

describe('visibleComms', () => {
  const log: Transmission[] = [
    t({ seq: 1, position: 'ground' }),
    t({ seq: 2, position: 'tower' }),
    t({ seq: 3, position: 'ground' }),
    t({ seq: 4, position: 'tower' }),
  ]

  it('shows only the calls made on the active frequency', () => {
    expect(visibleComms(log, 'ground', 20).map((x) => x.seq)).toEqual([1, 3])
    expect(visibleComms(log, 'tower', 20).map((x) => x.seq)).toEqual([2, 4])
  })

  it('keeps the most recent calls when the panel is capped', () => {
    expect(visibleComms(log, 'tower', 1).map((x) => x.seq)).toEqual([4])
  })

  it('returns oldest-first so the newest call is at the bottom', () => {
    const shown = visibleComms(log, 'ground', 20)
    expect(shown[0]!.seq).toBeLessThan(shown[shown.length - 1]!.seq)
  })
})
