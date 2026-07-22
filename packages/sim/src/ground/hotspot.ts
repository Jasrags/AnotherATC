import type { Hotspot, Point } from '../world/types'

/**
 * Charted hot spots — the junctions a field's own diagram warns you about.
 *
 * A hot spot is not geometry the sim derives; it is somewhere real controllers and pilots have
 * repeatedly got confused, published by the FAA because history says so. The only thing the sim
 * can do with that is **watch harder there**: inside one, traffic is called as converging while
 * it is still a few hundred feet apart, rather than at the nose-to-nose distance that counts as
 * a conflict on open pavement.
 *
 * Pure and total over its input, so it is deterministic and testable without a sim.
 */

/** How much earlier a conflict is called inside a hot spot, as a multiple of the open-pavement
 *  distance. The point of a hot spot is the warning arriving while you can still act on it. */
export const HOTSPOT_CONFLICT_FACTOR = 3

/** The hot spot containing this point, or null. Nearest centre wins where two overlap, so the
 *  answer is stable rather than depending on the order they were charted in. */
export function hotspotAt(p: Point, hotspots: readonly Hotspot[]): string | null {
  let best: { id: string; d: number } | null = null
  for (const hs of hotspots) {
    const d = Math.hypot(p[0] - hs.point[0], p[1] - hs.point[1])
    if (d > hs.radiusNm) continue
    if (!best || d < best.d) best = { id: hs.id, d }
  }
  return best?.id ?? null
}

/** Hot spots holding two or more aircraft right now, in charted order — the ones worth
 *  lighting up, because one aircraft in a hot spot is just an aircraft. */
export function busyHotspots(
  occupancy: readonly (string | null)[],
  hotspots: readonly Hotspot[],
): string[] {
  const counts = new Map<string, number>()
  for (const id of occupancy) {
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return hotspots.filter((hs) => (counts.get(hs.id) ?? 0) >= 2).map((hs) => hs.id)
}
