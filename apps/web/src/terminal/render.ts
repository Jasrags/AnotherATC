import type { Point, TerminalSnapshot } from '@anotheratc/sim'
import { toScreen, type View } from '../ground/view'
import { dataBlock } from './scene'

type Ctx = CanvasRenderingContext2D

/**
 * TRACON radar-scope palette — the classic terminal look: monochrome green on black, amber for the
 * range rings. Deliberately distinct from the ASDE-X surface palette (`ground/palette.ts`): a radar
 * scope is not a surface scope, and the two modes should read as different displays at a glance.
 */
export const RADAR = {
  bg: '#02060a',
  ring: '#1c3b2e', // range rings — dim, so they sit behind the traffic
  ringLabel: '#3f6f56',
  target: '#54f39a', // radar return — bright green
  targetGlow: 'rgba(84, 243, 154, 0.35)',
  trail: 'rgba(84, 243, 154, 0.28)', // fading history dots
  leader: '#2f7d5a', // velocity vector / leader line
  block: '#8ef0b4', // data-block text
} as const

export const RADAR_DIMS = {
  /** Range-ring spacing (nm). */
  ringStepNm: 5,
  /** How many rings to draw out from the field reference. */
  ringCount: 6,
  /** Target half-size (px). */
  targetR: 3,
  /** History-dot half-size (px). */
  trailR: 1.4,
  /** Projected-track (velocity vector) length, in seconds of travel — a 1-minute vector. */
  ptlSeconds: 60,
  blockFont: 12,
  /** Data-block offset from the target (px). */
  blockOffset: 12,
  blockLineHeight: 14,
} as const

/**
 * Where a target will be after `seconds` at its current heading and speed — the end of its velocity
 * vector, in world nm (x = east, y = north). Pure, so the leader-line geometry is testable.
 */
export function projectedTrackPoint(
  x: number,
  y: number,
  headingDeg: number,
  speedKt: number,
  seconds: number,
): Point {
  const distNm = (speedKt * seconds) / 3600
  const rad = (headingDeg * Math.PI) / 180
  return [x + distNm * Math.sin(rad), y + distNm * Math.cos(rad)]
}

/** Concentric range rings centered on the field reference, at {@link RADAR_DIMS.ringStepNm} spacing. */
function drawRangeRings(ctx: Ctx, v: View, center: Point): void {
  const [cx, cy] = toScreen(v, center[0], center[1])
  ctx.lineWidth = 1
  ctx.strokeStyle = RADAR.ring
  for (let i = 1; i <= RADAR_DIMS.ringCount; i += 1) {
    const rPx = i * RADAR_DIMS.ringStepNm * v.scale
    ctx.beginPath()
    ctx.arc(cx, cy, rPx, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawTrail(ctx: Ctx, v: View, trail: readonly Point[]): void {
  ctx.fillStyle = RADAR.trail
  const r = RADAR_DIMS.trailR
  // The last trail point coincides with the live blip; skip it so the history reads as "behind".
  for (let i = 0; i < trail.length - 1; i += 1) {
    const p = trail[i]
    if (!p) continue
    const [sx, sy] = toScreen(v, p[0], p[1])
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2)
  }
}

function drawLeader(ctx: Ctx, v: View, from: Point, ahead: Point): void {
  const [sx, sy] = toScreen(v, from[0], from[1])
  const [ax, ay] = toScreen(v, ahead[0], ahead[1])
  ctx.strokeStyle = RADAR.leader
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.lineTo(ax, ay)
  ctx.stroke()
}

function drawTarget(ctx: Ctx, sx: number, sy: number): void {
  const r = RADAR_DIMS.targetR
  ctx.fillStyle = RADAR.targetGlow
  ctx.fillRect(sx - r - 2, sy - r - 2, (r + 2) * 2, (r + 2) * 2)
  ctx.fillStyle = RADAR.target
  ctx.fillRect(sx - r, sy - r, r * 2, r * 2)
}

function drawDataBlock(ctx: Ctx, sx: number, sy: number, line1: string, line2: string): void {
  ctx.fillStyle = RADAR.block
  ctx.font = `${RADAR_DIMS.blockFont}px ui-monospace, "SF Mono", Menlo, monospace`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const bx = sx + RADAR_DIMS.blockOffset
  const by = sy + RADAR_DIMS.blockOffset
  ctx.fillText(line1, bx, by)
  ctx.fillText(line2, bx, by + RADAR_DIMS.blockLineHeight)
}

/**
 * Draw the terminal radar picture: range rings around the field reference, then each target with its
 * history trail, velocity vector, blip, and data block (callsign / altitude-hundreds / groundspeed).
 * `center` is the field reference the rings are drawn around.
 */
export function drawTerminalScene(
  ctx: Ctx,
  v: View,
  snapshot: TerminalSnapshot,
  width: number,
  height: number,
  center: Point,
): void {
  ctx.fillStyle = RADAR.bg
  ctx.fillRect(0, 0, width, height)

  drawRangeRings(ctx, v, center)

  for (const ac of snapshot.aircraft) {
    const pos = ac.position
    drawTrail(ctx, v, ac.trail)
    const ahead = projectedTrackPoint(pos[0], pos[1], ac.headingDeg, ac.speedKt, RADAR_DIMS.ptlSeconds)
    drawLeader(ctx, v, pos, ahead)
    const [sx, sy] = toScreen(v, pos[0], pos[1])
    drawTarget(ctx, sx, sy)
    const block = dataBlock(ac.callsign, ac.altitudeFt, ac.speedKt)
    drawDataBlock(ctx, sx, sy, block.line1, block.line2)
  }
}
