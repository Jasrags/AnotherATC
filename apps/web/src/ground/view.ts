import type { Bounds } from '@anotheratc/sim'

/** Maps world nm (x=east, y=north) to screen px (y flipped). scale = px per nm. */
export interface View {
  scale: number
  offX: number
  offY: number
}

export function fitView(bounds: Bounds, width: number, height: number, pad = 48): View {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6)
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6)
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h)
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return { scale, offX: width / 2 - cx * scale, offY: height / 2 + cy * scale }
}

export function toScreen(v: View, x: number, y: number): [number, number] {
  return [x * v.scale + v.offX, -y * v.scale + v.offY]
}

/** Inverse of toScreen: screen px → world nm. */
export function toWorld(v: View, sx: number, sy: number): [number, number] {
  return [(sx - v.offX) / v.scale, (v.offY - sy) / v.scale]
}

/** Zoom scale bounds (px per nm). Prevents runaway zoom from collapsing the scale
 *  toward 0 (pavement vanishes, hit-testing radii explode) or blowing it up. */
export const MIN_SCALE = 50
export const MAX_SCALE = 20000

/** Zoom by `factor` keeping the world point under (sx, sy) fixed on screen. Scale is
 *  clamped to [MIN_SCALE, MAX_SCALE]; the cursor point stays fixed at the clamped scale. */
export function zoomAt(v: View, factor: number, sx: number, sy: number): View {
  const wx = (sx - v.offX) / v.scale
  const wy = (v.offY - sy) / v.scale
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
  return { scale, offX: sx - wx * scale, offY: sy + wy * scale }
}

export function pan(v: View, dx: number, dy: number): View {
  return { scale: v.scale, offX: v.offX + dx, offY: v.offY + dy }
}

/** Adjust a view for a canvas resize: keep the current zoom and hold the world point
 *  that was at the old screen center at the new screen center (so a resize/reflow does
 *  not throw away the controller's pan/zoom the way a fresh fitView would). */
export function reframe(v: View, oldW: number, oldH: number, newW: number, newH: number): View {
  const wx = (oldW / 2 - v.offX) / v.scale
  const wy = (v.offY - oldH / 2) / v.scale
  return { scale: v.scale, offX: newW / 2 - wx * v.scale, offY: newH / 2 + wy * v.scale }
}
