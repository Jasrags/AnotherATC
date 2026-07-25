import { describe, expect, test } from 'vitest'
import { projectedTrackPoint } from './render'

describe('projectedTrackPoint', () => {
  test('a target heading north advances in +y by speed×time', () => {
    // 360 kt for 60 s = 6 nm.
    const [x, y] = projectedTrackPoint(0, 0, 0, 360, 60)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(6, 6)
  })

  test('a target heading east advances in +x', () => {
    const [x, y] = projectedTrackPoint(1, 2, 90, 360, 60)
    expect(x).toBeCloseTo(7, 6)
    expect(y).toBeCloseTo(2, 6)
  })

  test('a stationary target does not move', () => {
    expect(projectedTrackPoint(3, 4, 123, 0, 60)).toEqual([3, 4])
  })
})
