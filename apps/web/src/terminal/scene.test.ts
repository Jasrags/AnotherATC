import { describe, expect, test } from 'vitest'
import { KSAN, findRunway } from '@anotheratc/sim'
import {
  ARRIVAL_SPEED_KT,
  FEEDER_ALTITUDE_FT,
  FEEDER_DISTANCE_NM,
  dataBlock,
  demoArrivalInit,
  formatAltitudeHundreds,
  inboundHeadingDeg,
} from './scene'

describe('inboundHeadingDeg', () => {
  test('due north is 0°', () => {
    expect(inboundHeadingDeg(0, 0, 0, 5)).toBe(0)
  })

  test('due east is 90°', () => {
    expect(inboundHeadingDeg(0, 0, 5, 0)).toBe(90)
  })

  test('due south is 180°', () => {
    expect(inboundHeadingDeg(0, 0, 0, -5)).toBe(180)
  })

  test('due west is 270°', () => {
    expect(inboundHeadingDeg(0, 0, -5, 0)).toBe(270)
  })
})

describe('demoArrivalInit', () => {
  test('enters on the extended final at the feeder distance, tracking the threshold', () => {
    const runway = findRunway(KSAN, KSAN.defaultRunway)!
    const init = demoArrivalInit(KSAN)

    // The entry point sits FEEDER_DISTANCE_NM from the threshold.
    const distToThreshold = Math.hypot(
      init.position[0] - runway.threshold[0],
      init.position[1] - runway.threshold[1],
    )
    expect(distToThreshold).toBeCloseTo(FEEDER_DISTANCE_NM, 6)

    // …on the approach side (farther from the far end than the threshold is).
    const distFarToEntry = Math.hypot(
      init.position[0] - runway.farEnd[0],
      init.position[1] - runway.farEnd[1],
    )
    const distFarToThreshold = Math.hypot(
      runway.threshold[0] - runway.farEnd[0],
      runway.threshold[1] - runway.farEnd[1],
    )
    expect(distFarToEntry).toBeGreaterThan(distFarToThreshold)

    // Heading points from the entry point back at the threshold.
    expect(init.headingDeg).toBeCloseTo(
      inboundHeadingDeg(init.position[0], init.position[1], runway.threshold[0], runway.threshold[1]),
      6,
    )
  })

  test('enters at the feeder altitude and arrival speed, flying straight (no assigned targets)', () => {
    const init = demoArrivalInit(KSAN)
    expect(init.altitudeFt).toBe(FEEDER_ALTITUDE_FT)
    expect(init.speedKt).toBe(ARRIVAL_SPEED_KT)
    expect(init.targetHeadingDeg).toBeUndefined()
    expect(init.targetAltitudeFt).toBeUndefined()
    expect(init.targetSpeedKt).toBeUndefined()
  })
})

describe('data block formatting', () => {
  test('altitude is hundreds of feet, three digits', () => {
    expect(formatAltitudeHundreds(6000)).toBe('060')
    expect(formatAltitudeHundreds(11500)).toBe('115')
    expect(formatAltitudeHundreds(0)).toBe('000')
  })

  test('altitude rounds to the nearest hundred and never goes negative', () => {
    expect(formatAltitudeHundreds(6040)).toBe('060')
    expect(formatAltitudeHundreds(6060)).toBe('061')
    expect(formatAltitudeHundreds(-50)).toBe('000')
  })

  test('data block is callsign then altitude and rounded groundspeed', () => {
    expect(dataBlock('SKW482', 6000, 249.6)).toEqual({ line1: 'SKW482', line2: '060 250' })
  })
})
