import { findRunway, type Airport, type TerminalAircraftInit } from '@anotheratc/sim'

/**
 * Pure scene helpers for the TRACON radar scope (docs/atc-tracon.md §6, Slice 1). The scope is
 * render-only this slice: it spawns one arrival at a feeder-fix-like point on the active runway's
 * extended final and lets the terminal sim fly it straight in, level, at constant speed — "an
 * arrival spawns at a feeder fix at altitude and flies its inbound course."
 *
 * The three constants below are Slice-1 scaffolding, not field data: real feeder fixes (named entry
 * points with published crossing altitudes) become part of the `Airport` bundle in a later slice
 * (docs/atc-tracon.md §5). Until then the demo arrival is derived from runway geometry the bundle
 * already carries, so it lands correctly at any field.
 */

/** How far out (nm) the demo arrival enters, on the extended final approach course. */
export const FEEDER_DISTANCE_NM = 15
/** Crossing altitude (ft) at entry — terminal, well below the ~18,000-ft ceiling. */
export const FEEDER_ALTITUDE_FT = 6000
/** Entry groundspeed (kt), a typical terminal-arrival descent speed. */
export const ARRIVAL_SPEED_KT = 250

/**
 * True bearing (deg, 0 = north, 90 = east) from one world point toward another, in [0, 360).
 * Matches the terminal sim's heading convention (x = east, y = north).
 */
export function inboundHeadingDeg(fromX: number, fromY: number, toX: number, toY: number): number {
  const deg = (Math.atan2(toX - fromX, toY - fromY) * 180) / Math.PI
  return ((deg % 360) + 360) % 360
}

/**
 * The Slice-1 demo arrival for a field: on the active runway's extended final, {@link
 * FEEDER_DISTANCE_NM} out, at {@link FEEDER_ALTITUDE_FT}, tracking inbound toward the threshold.
 * Targets are left to default to the current state, so it flies straight, level, and constant-speed
 * until a controller vectors it (Slice 2).
 */
export function demoArrivalInit(airport: Airport): TerminalAircraftInit {
  const runway = findRunway(airport, airport.defaultRunway)
  if (!runway) throw new Error(`${airport.icao}: no active runway "${airport.defaultRunway}"`)
  const [tx, ty] = runway.threshold
  const [fx, fy] = runway.farEnd
  // Unit vector along the extended final, pointing from the far end toward the threshold and on out
  // the approach side (the same direction finalFix uses).
  const dx = tx - fx
  const dy = ty - fy
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const position: [number, number] = [tx + ux * FEEDER_DISTANCE_NM, ty + uy * FEEDER_DISTANCE_NM]
  return {
    id: 'demo-arr',
    callsign: 'SKW482',
    type: 'E75L',
    wake: 'M',
    position,
    altitudeFt: FEEDER_ALTITUDE_FT,
    headingDeg: inboundHeadingDeg(position[0], position[1], tx, ty),
    speedKt: ARRIVAL_SPEED_KT,
  }
}

/** Altitude as a radar data block shows it: hundreds of feet, three digits (6,000 ft → "060"). */
export function formatAltitudeHundreds(altitudeFt: number): string {
  return String(Math.max(0, Math.round(altitudeFt / 100))).padStart(3, '0')
}

/** The two data-block lines for a target: callsign, then altitude (hundreds) and groundspeed (kt). */
export interface DataBlock {
  line1: string
  line2: string
}

export function dataBlock(callsign: string, altitudeFt: number, speedKt: number): DataBlock {
  return {
    line1: callsign,
    line2: `${formatAltitudeHundreds(altitudeFt)} ${Math.round(speedKt)}`,
  }
}
