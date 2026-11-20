// WGS84 inverse Transverse Mercator series and MGRS grid rules from GEOTRANS.
// Reference: https://github.com/hobu/mgrs/tree/1.5.4/libmgrs (tranmerc.c, mgrs.c).
// GEOTRANS specifies no license or reuse restrictions for these components.
// Preserve the southwest corner, including cells crossing a band or antimeridian.
const a = 6378137, f = 1 / 298.257223563, es = 2 * f - f * f, ebs = es / (1 - es), k = .9996
const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n
const ap = a * (1 - n + 5 * (n2 - n3) / 4 + 81 * (n4 - n5) / 64)
const bp = 3 * a * (n - n2 + 7 * (n3 - n4) / 8 + 55 * n5 / 64) / 2
const cp = 15 * a * (n2 - n3 + 3 * (n4 - n5) / 4) / 16
const dp = 35 * a * (n3 - n4 + 11 * n5 / 16) / 48
const ep = 315 * a * (n4 - n5) / 512
const meridian = (p: number) => ap * p - bp * Math.sin(2 * p) + cp * Math.sin(4 * p) - dp * Math.sin(6 * p) + ep * Math.sin(8 * p)
const radius = (p: number) => a * (1 - es) / (1 - es * Math.sin(p) ** 2) ** 1.5
const bands = 'CDEFGHJKLMNPQRSTUVWX', rows = 'ABCDEFGHJKLMNPQRSTUV'
const minimum = [1100000, 2000000, 2800000, 3700000, 4600000, 5500000, 6400000, 7300000, 8200000, 9100000, 0, 800000, 1700000, 2600000, 3500000, 4400000, 5300000, 6200000, 7000000, 7900000]

export function parseUtm(grid: string): [number, number] {
  const match = /^(\d+)([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-Z])(\d*)$/.exec(grid)!
  const zone = Number(match[1]), band = bands.indexOf(match[2]), column = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(zone - 1) % 3].indexOf(match[3])
  const row = rows.indexOf(match[4]), digits = match[5], precision = digits.length / 2, scale = 10 ** (5 - precision)
  if (column < 0 || row < 0 || match[2] === 'X' && [32, 34, 36].includes(zone) || zone === 31 && match[2] === 'V' && column > 3) throw Error('Invalid MGRS grid reference')
  const easting = (column + 1) * 100000 + Number(digits.slice(0, precision)) * scale
  let northing = ((row * 100000 - (zone % 2 === 0 ? 500000 : 0)) + 2000000) % 2000000
  while (northing < minimum[band]) northing += 2000000
  northing += Number(digits.slice(precision)) * scale
  if (northing > 10000000) throw Error('Invalid MGRS grid reference')
  const tmd = (northing - (band < 10 ? 10000000 : 0)) / k
  let p = tmd / radius(0)
  for (let i = 0; i < 5; i++) p += (tmd - meridian(p)) / radius(p)
  const sr = radius(p), sn = a / Math.sqrt(1 - es * Math.sin(p) ** 2), c = Math.cos(p), t = Math.tan(p)
  const t2 = t * t, t4 = t2 * t2, eta = ebs * c * c, e2 = eta * eta, e3 = e2 * eta, e4 = e3 * eta
  const de = easting - 500000
  const t10 = t / (2 * sr * sn * k ** 2)
  const t11 = t * (5 + 3 * t2 + eta - 4 * e2 - 9 * t2 * eta) / (24 * sr * sn ** 3 * k ** 4)
  const t12 = t * (61 + 90 * t2 + 46 * eta + 45 * t4 - 252 * t2 * eta - 3 * e2 + 100 * e3 - 66 * t2 * e2 - 90 * t4 * eta + 88 * e4 + 225 * t4 * e2 + 84 * t2 * e3 - 192 * t2 * e4) / (720 * sr * sn ** 5 * k ** 6)
  const t13 = t * (1385 + 3633 * t2 + 4095 * t4 + 1575 * t ** 6) / (40320 * sr * sn ** 7 * k ** 8)
  const latitude = (p - de ** 2 * t10 + de ** 4 * t11 - de ** 6 * t12 + de ** 8 * t13) * 180 / Math.PI
  const t14 = 1 / (sn * c * k)
  const t15 = (1 + 2 * t2 + eta) / (6 * sn ** 3 * c * k ** 3)
  const t16 = (5 + 6 * eta + 28 * t2 - 3 * e2 + 8 * t2 * eta + 24 * t4 - 4 * e3 + 4 * t2 * e2 + 24 * t2 * e3) / (120 * sn ** 5 * c * k ** 5)
  const t17 = (61 + 662 * t2 + 1320 * t4 + 720 * t ** 6) / (5040 * sn ** 7 * c * k ** 7)
  let longitude = (zone * 6 - 183) + (de * t14 - de ** 3 * t15 + de ** 5 * t16 - de ** 7 * t17) * 180 / Math.PI
  if (longitude > 180) longitude -= 360
  if (longitude < -180) longitude += 360
  const tolerance = 10 ** -precision, south = -80 + band * 8, north = band === 19 ? 84 : south + 8
  if (latitude < south - tolerance || latitude > north + tolerance) throw Error('Invalid MGRS grid reference')
  return [longitude, latitude]
}
