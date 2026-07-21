// Authentic ASDE-X surface-scope palette: very dark ground, faint pavement,
// bright glowing targets, green data blocks, amber hold-short marks.
export const COLORS = {
  bg: '#04080d',
  apronFill: '#0a1119',
  apronEdge: '#13202c',
  buildingFill: '#0d1822',
  buildingEdge: '#1d2f3d',
  taxiway: '#153040',
  taxiwayCenter: '#2c6a4c',
  runway: '#101d29',
  runwayEdge: '#43566a',
  runwayCenter: '#7a90a5',
  runwayThreshold: '#c6d6e4', // solid bar at the (displaced) landing threshold
  runwayMarking: '#93a9bd', // painted markings: displaced-threshold arrows, designators
  emas: '#c9911f', // arresting-bed chevrons — unusable pavement, marked as such
  emasFill: '#241a0c',
  holdShort: '#d79a2b',
  stand: '#1f3e4f', // gate/parking guidance lines (subtle — not a dominant feature)
  standLine: '#8a7a33', // painted stand lead-in lines and stop bars
  gateNode: '#4a7285', // gate-node stand markers (e.g. Terminal 1, which has no stand lines)
  gateLabel: '#a9d0e2', // gate numbers (shown when zoomed in)
  target: '#f2f9ff',
  targetHalo: '#7fd4ff',
  conflict: '#ff5a4d', // separation conflict alert
  targetHold: '#9aacbd',
  airborneTarget: '#7fd4ff', // traffic on final — hollow, to read as "not on the surface"
  approachCourse: '#2f5d72', // the extended runway centerline arrivals fly in on
  approachTick: '#4a7f96', // 1-nm range ticks along that course
  exitAvailable: '#4d7f6a', // a turnoff the landing aircraft could still be assigned
  exitAssigned: '#7ff0b0', // the turnoff it is actually planning for
  leader: '#5aa8cb',
  block1: '#8ef0b4',
  block2: '#54b487',
  connector: '#2b4a5b',
  holdShortTarget: '#f4b64e',
  selection: '#ffd24a',
  route: '#49d3ff',
  routeDest: '#8becff',
  routeVia: '#6fe0ff', // taxiways picked while assembling a "taxi via …" clearance
  labelTaxi: '#d3bd74', // signage yellow — distinct from the green aircraft blocks
  labelRwy: '#aebfce',
  labelArea: '#6f8493', // muted blue-gray for ramp/terminal area names
  labelHalo: 'rgba(4, 8, 13, 0.92)',
  hotspot: '#e0932f', // charted hot-spot orange
  // Admin routing-graph overlay (debug layer, deliberately off-palette from gameplay).
  graphEdge: '#7c5cff', // contracted taxiway run
  graphEdgeFlag: '#ff4d94', // long dead-straight run → eyeball vs. the chart
  graphNode: '#b9a3ff', // decision node (endpoint / name-change)
  graphJunction: '#efe8ff', // junction (degree ≥ 3)
  // Dev sandbox: routing-probe path + placement preview.
  probePath: '#38e0c8', // shortest-path probe between two clicked points
  probeBad: '#ff5a4d', // second point set but no route found
} as const

export const DIMS = {
  /** Target half-size in px. */
  targetR: 3.2,
  blockFont: 11,
  /** Data-block offset from the target, px. */
  blockLeader: 15,
  /** Projected-track (velocity vector) length, in seconds of travel.
   *  Short, because surface speeds are low — a 1-min vector would span the field. */
  ptlSeconds: 15,
  /** Hide the velocity vector below this groundspeed (kt) — parked/creeping aircraft. */
  ptlMinSpeedKt: 3,
  /** Default pavement widths in nm when OSM omits width. */
  taxiwayNm: 0.012,
  runwayNm: 0.033,
  standNm: 0.004,
  /** Half-length (nm) of the 1-nm range ticks drawn across the final approach course. */
  approachTickNm: 0.05,
  /** How far (px) an off-screen traffic marker sits in from the canvas edge. */
  edgeMarkerPad: 34,
} as const
