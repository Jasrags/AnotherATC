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

/** Zoom by `factor` keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(v: View, factor: number, sx: number, sy: number): View {
  const wx = (sx - v.offX) / v.scale
  const wy = (v.offY - sy) / v.scale
  const scale = v.scale * factor
  return { scale, offX: sx - wx * scale, offY: sy + wy * scale }
}

export function pan(v: View, dx: number, dy: number): View {
  return { scale: v.scale, offX: v.offX + dx, offY: v.offY + dy }
}
