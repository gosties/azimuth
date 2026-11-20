// WGS84 polar stereographic (UPS), scale .994 and false origin 2,000,000 m.
// MGRS letter ranges follow the public GEOTRANS UPS grid specification.
// Reference: https://github.com/hobu/mgrs/tree/1.5.4/libmgrs (mgrs.c, polarst.c, ups.c).
// GEOTRANS specifies no license or reuse restrictions for these components.
const eccentricity = Math.sqrt(0.0066943799901413165)
const rad = Math.PI / 180
// WGS84 UPS true-scale latitude used by the coordinate parser.
const origin = 81.114528 * rad, esOrigin = eccentricity * Math.sin(origin)
const tc = Math.tan(Math.PI / 4 - origin / 2) / ((1 - esOrigin) / (1 + esOrigin)) ** (eccentricity / 2)
const factor = 6378137 * Math.cos(origin) / Math.sqrt(1 - esOrigin * esOrigin) / tc
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const west = 'JKLPQRSTUXYZ', east = 'ABCFGHJKLPQR'
const bands = {
  A: { columns: west, x: 800000, y: 800000, rows: alphabet, north: false },
  B: { columns: east, x: 2000000, y: 800000, rows: alphabet, north: false },
  Y: { columns: west, x: 800000, y: 1300000, rows: alphabet.slice(0, 14), north: true },
  Z: { columns: east.slice(0, 7), x: 2000000, y: 1300000, rows: alphabet.slice(0, 14), north: true },
}

export function parseUps(grid: string): [number, number] {
  const band = bands[grid[0] as keyof typeof bands]
  const column = band.columns.indexOf(grid[1]), row = band.rows.indexOf(grid[2])
  if (column < 0 || row < 0) throw Error('Invalid MGRS grid reference')
  const digits = grid.slice(3), precision = digits.length / 2, scale = 10 ** (5 - precision)
  const x = band.x + column * 100000 + Number(digits.slice(0, precision)) * scale - 2000000
  const y = band.y + row * 100000 + Number(digits.slice(precision)) * scale - 2000000
  const t = Math.hypot(x, y) / factor
  let phi = Math.PI / 2 - 2 * Math.atan(t)
  for (let i = 0; i < 12; i++) {
    const es = eccentricity * Math.sin(phi)
    phi = Math.PI / 2 - 2 * Math.atan(t * ((1 - es) / (1 + es)) ** (eccentricity / 2))
  }
  const latitude = phi / rad * (band.north ? 1 : -1)
  if (band.north ? latitude < 83.5 : latitude > -79.5) throw Error('Invalid MGRS grid reference')
  return [t === 0 ? 0 : Math.atan2(x, band.north ? -y : y) / rad, latitude]
}

export function formatUps(latitude: number, longitude: number): string {
  const phi = Math.abs(latitude) * rad, es = eccentricity * Math.sin(phi)
  const rho = Math.abs(latitude) === 90 ? 0 : factor * Math.tan(Math.PI / 4 - phi / 2) / ((1 - es) / (1 + es)) ** (eccentricity / 2)
  const x = Math.floor(2000000 + rho * Math.sin(longitude * rad))
  const y = Math.floor(2000000 + rho * Math.cos(longitude * rad) * (latitude > 0 ? -1 : 1))
  const letter = latitude > 0 ? x < 2000000 ? 'Y' : 'Z' : x < 2000000 ? 'A' : 'B'
  const band = bands[letter]
  return letter + band.columns[Math.floor((x - band.x) / 100000)] + band.rows[Math.floor((y - band.y) / 100000)]
    + String(x % 100000).padStart(5, '0') + String(y % 100000).padStart(5, '0')
}
