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
  holdShort: '#d79a2b',
  stand: '#122130',
  target: '#f2f9ff',
  targetHalo: '#7fd4ff',
  targetHold: '#9aacbd',
  leader: '#5aa8cb',
  block1: '#8ef0b4',
  block2: '#54b487',
  connector: '#2b4a5b',
  holdShortTarget: '#f4b64e',
  selection: '#ffd24a',
  route: '#49d3ff',
  routeDest: '#8becff',
  labelTaxi: '#d3bd74', // signage yellow — distinct from the green aircraft blocks
  labelRwy: '#aebfce',
  labelHalo: 'rgba(4, 8, 13, 0.92)',
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
} as const
