import type { AirportSurface, Point } from '../world/types'

/**
 * Stand geometry: the painted lead-in line an aircraft follows onto a gate, and back out.
 *
 * Real stands are not points. The aircraft is guided onto the stand along a painted line that
 * curves off the taxilane, stops with the nose on a mark, and is pushed back out along the same
 * line. Modelling the stand as a bare point is what makes an arrival cut across the apron to it
 * and a pushback shove off in whatever direction the nearest node happens to lie.
 *
 * OSM maps these as `aeroway=parking_position` ways, which the ingest already carries. Their
 * direction is not consistent — at KSAN 28 run taxilane→stand and 4 run the other way — so which
 * end is the stand is resolved per line against the gate node rather than assumed. Where a field
 * has no painted line mapped (KSAN's own Terminal 1), one is derived straight off the nearest
 * taxi pavement, so every gate is usable and the difference is stated rather than hidden.
 *
 * Not every stand has a gate node. KSAN maps 23 parking lines with no node at all — the North
 * Ramp, the West/Island ramp, the commuter and east-side stands — which is most of the field's
 * non-airline parking. Those are built from the line alone, orienting on the taxi network
 * instead: the end nearer the pavement is where you come in from, so the other end is the stand.
 */
export interface Stand {
  /** Stand designator ("39", "101", "N6"). */
  ref: string
  /** A terminal gate (built from a tagged gate node) or a remote stand known only by its
   *  painted line — cargo, GA and commuter parking. The spawner works terminal gates; a remote
   *  stand is somewhere traffic can be *sent*, which is what makes it usable at all. */
  kind: 'terminal' | 'remote'
  /** The gate node — where the stand is labelled, which is not where the nose stops. Null for a
   *  remote stand: those have a painted line and no node, which is why they need a different
   *  rule for which end is which. */
  gate: Point | null
  /** The lead-in line, ordered taxilane → nose stop, keeping the painted curve. */
  lead: readonly Point[]
  /** Where the lead-in meets the taxilane: `lead[0]`. Entered forwards, left backwards. */
  entry: Point
  /** Where the nose stops: the last point of `lead`. */
  stop: Point
  /** Nose heading (deg true) when parked, along the final leg of the lead-in. */
  headingDeg: number
  /** `charted` = a mapped parking_position way; `derived` = a straight stub to the nearest
   *  taxi pavement, for a stand whose line was never mapped. */
  source: 'charted' | 'derived'
}

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Bearing (deg true, 0 = north) from `a` to `b`. */
function bearing(a: Point, b: Point): number {
  const deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI
  return (deg + 360) % 360
}

/** Nearest point to `p` on the segment `a`–`b`. */
export function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return a
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return [a[0] + t * dx, a[1] + t * dy]
}

/** Distance from `p` to the segment `a`–`b`. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  return dist(p, nearestOnSegment(p, a, b))
}

/** Pavement an aircraft can taxi on — what a derived lead-in leads in *from*. */
const TAXI_KINDS = new Set(['taxiway', 'taxilane'])

/** Shortest lead-in worth deriving (nm ≈ 9 m). A gate node mapped *on* the taxi network — a
 *  stand at the end of a lane — would otherwise derive a zero-length line, leaving the aircraft
 *  with no direction to face and nothing to push back along. Below this the entry is taken
 *  further back along the pavement instead, so the lane's own last stretch becomes the lead-in. */
const MIN_LEAD_NM = 0.005

/** Distance from a point to the nearest taxi pavement. Unlike {@link nearestTaxiPoint} this has
 *  no minimum: it answers "how close is this to the network", which is what decides which end of
 *  an unlabelled stand line you drive in from. Using the minimum-distance version here would
 *  mean a line whose entry sits *on* the pavement measured as further away than its own stand. */
export function distToTaxi(surface: AirportSurface, p: Point): number {
  let best = Infinity
  for (const f of surface.features) {
    if (!TAXI_KINDS.has(f.kind)) continue
    for (let i = 1; i < f.points.length; i += 1) {
      best = Math.min(best, distToSegment(p, f.points[i - 1] as Point, f.points[i] as Point))
    }
  }
  return best
}

/** Nearest point on any taxi pavement at least `MIN_LEAD_NM` away, or null when the field has
 *  no pavement in reach. Segment endpoints are candidates as well as perpendicular projections,
 *  so a gate at the very end of a lane falls back to the lane's previous vertex. */
function nearestTaxiPoint(surface: AirportSurface, p: Point): Point | null {
  let best: Point | null = null
  let bestD = Infinity
  const consider = (q: Point): void => {
    const d = dist(p, q)
    if (d >= MIN_LEAD_NM && d < bestD) {
      bestD = d
      best = q
    }
  }
  for (const f of surface.features) {
    if (!TAXI_KINDS.has(f.kind)) continue
    for (let i = 0; i < f.points.length; i += 1) {
      consider(f.points[i] as Point)
      if (i > 0) consider(nearestOnSegment(p, f.points[i - 1] as Point, f.points[i] as Point))
    }
  }
  return best
}

/** Nose setback (nm ≈ 25 m) used when a field has no charted stands to measure one from. */
const DEFAULT_SETBACK_NM = 0.0135

/** Distance a nose actually stops short of the gate label node, measured from the field's own
 *  charted stands. A gate node marks the stand at the terminal, not the stop mark — at KSAN by
 *  a median of 28 m — so a derived lead-in run all the way to it parks the aircraft on the
 *  building. Calibrating from the same airport beats inventing a constant. */
function setbackFrom(charted: readonly { gate: Point; stop: Point }[]): number {
  if (charted.length === 0) return DEFAULT_SETBACK_NM
  const gaps = charted.map((s) => dist(s.gate, s.stop)).sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] as number
}

/**
 * Build one stand per gate node.
 *
 * Lines are matched to stands **by designator, never by proximity**: adjacent stands sit closer
 * together than a gate node sits from its own line, so nearest-endpoint matching picks a
 * neighbour's line for roughly a third of the field.
 */
export function buildStands(surface: AirportSurface): Stand[] {
  const charted = new Map<string, readonly Point[]>()
  for (const f of surface.features) {
    if (f.kind !== 'parking_position' || !f.ref || f.points.length < 2) continue
    // A line whose endpoints coincide carries no direction, so it cannot say which way the
    // aircraft faces or which way it pushes back. Treated as absent, which falls through to a
    // derived lead-in rather than silently parking the aircraft facing due north.
    if (dist(f.points[0] as Point, f.points[f.points.length - 1] as Point) < MIN_LEAD_NM) continue
    if (!charted.has(f.ref)) charted.set(f.ref, f.points)
  }

  // Resolve the charted stands first: they are what the derived ones are calibrated against.
  const draft: {
    ref: string
    gate: Point | null
    kind: Stand['kind']
    lead: Point[]
    source: Stand['source']
  }[] = []
  const seen = new Set<string>()
  for (const f of surface.features) {
    if (f.kind !== 'gate' || !f.ref || seen.has(f.ref)) continue
    const gate = f.points[0]
    if (!gate) continue
    seen.add(f.ref)

    const line = charted.get(f.ref)
    if (line) {
      // The end nearer the gate node is the stand end; flip the line if it runs the other way.
      // Ties are impossible in practice (a gate node equidistant from both ends of its own
      // line) and resolve to "as mapped", which is the majority direction at KSAN.
      const head = line[0] as Point
      const tail = line[line.length - 1] as Point
      const lead = dist(head, gate) < dist(tail, gate) ? [...line].reverse() : [...line]
      draft.push({ ref: f.ref, gate, kind: 'terminal', lead, source: 'charted' })
      continue
    }
    const entry = nearestTaxiPoint(surface, gate)
    if (!entry) continue
    draft.push({ ref: f.ref, gate, kind: 'terminal', lead: [entry, gate], source: 'derived' })
  }

  // Then the stands that exist only as paint. With no gate node to measure against, the taxi
  // network decides: the end nearer the pavement is the one you enter from.
  for (const f of surface.features) {
    if (f.kind !== 'parking_position' || !f.ref || f.points.length < 2) continue
    // OSM ref casing is inconsistent — KSAN's North Ramp is N1…N10 with a lone lowercase "n6".
    const ref = f.ref.toUpperCase()
    if (seen.has(ref)) continue
    const head = f.points[0] as Point
    const tail = f.points[f.points.length - 1] as Point
    if (dist(head, tail) < MIN_LEAD_NM) continue
    seen.add(ref)
    const lead =
      distToTaxi(surface, head) <= distToTaxi(surface, tail) ? [...f.points] : [...f.points].reverse()
    draft.push({ ref, gate: null, kind: 'remote', lead, source: 'charted' })
  }

  const setback = setbackFrom(
    draft
      .filter((d): d is typeof d & { gate: Point } => d.source === 'charted' && d.gate !== null)
      .map((d) => ({ gate: d.gate, stop: d.lead[d.lead.length - 1] as Point })),
  )

  const stands: Stand[] = []
  for (const d of draft) {
    let lead = d.lead
    if (d.source === 'derived' && d.gate) {
      // Stop the nose short of the label node by the field's own measured setback, instead of
      // running the line all the way in — which parks the aircraft on the terminal itself.
      const entry = lead[0] as Point
      const len = dist(entry, d.gate)
      const keep = len - setback
      if (keep > MIN_LEAD_NM) {
        const ux = (d.gate[0] - entry[0]) / len
        const uy = (d.gate[1] - entry[1]) / len
        lead = [entry, [entry[0] + ux * keep, entry[1] + uy * keep]]
      }
    }
    const stop = lead[lead.length - 1] as Point
    const prev = lead[lead.length - 2] as Point
    stands.push({
      ref: d.ref,
      kind: d.kind,
      gate: d.gate,
      lead,
      entry: lead[0] as Point,
      stop,
      headingDeg: bearing(prev, stop),
      source: d.source,
    })
  }
  return stands
}

/** The stand with this designator, or undefined. */
export function findStand(stands: readonly Stand[], ref: string | null): Stand | undefined {
  return ref === null ? undefined : stands.find((s) => s.ref === ref)
}
