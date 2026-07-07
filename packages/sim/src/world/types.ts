export interface LatLon {
  lat: number
  lon: number
}

/** A point in local nautical miles: x = east, y = north, relative to the airport ref. */
export type Point = readonly [number, number]

export type SurfaceKind =
  | 'aerodrome'
  | 'apron'
  | 'terminal'
  | 'hangar'
  | 'runway'
  | 'stopway'
  | 'taxiway'
  | 'taxilane'
  | 'parking_position'
  | 'holding_position'
  | 'gate'

export interface SurfaceFeature {
  kind: SurfaceKind
  points: Point[]
  /** Taxiway/runway designator (e.g. "B7", "9/27") or stand ref, when known. */
  ref?: string
  /** Pavement width in nm, when tagged. */
  widthNm?: number
  /** True when the polyline closes into a polygon (aprons, buildings). */
  closed?: boolean
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface AirportSurface {
  icao: string
  name: string
  ref: LatLon & { elevationFt: number }
  units: string
  source: string
  bounds: Bounds
  features: SurfaceFeature[]
}
