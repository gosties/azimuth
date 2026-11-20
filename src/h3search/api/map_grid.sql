, projected AS (
  SELECT table_id,
    mod(mod((CAST({half_world} AS DOUBLE) * CAST(lon AS DOUBLE)) / 180.0 + {half_world}, {world}) + {world}, {world}) AS x,
    {sphere_radius} * ln(tan(pi() * (greatest(-{max_latitude}, least({max_latitude}, lat)) + 90.0) / 360.0)) AS y
  FROM matches
), axial AS (
  SELECT *, x / {step} - y / {triple_hex_radius} AS aq, 2 * y / {triple_hex_radius} AS ar FROM projected
), rounded AS (
  SELECT *, floor(aq + .5) AS rx, floor(ar + .5) AS rz, floor(-aq - ar + .5) AS ry FROM axial
), errors AS (
  SELECT *, abs(rx - aq) AS dx, abs(rz - ar) AS dz, abs(ry + aq + ar) AS dy FROM rounded
), assigned AS (
  SELECT *,
    CASE WHEN {mode_hex} = 0 THEN floor(x / {step} + .5)
      WHEN dx > dy AND dx > dz THEN -ry - rz ELSE rx END AS raw_q,
    CASE WHEN {mode_hex} = 0 THEN floor(y / {step} + .5)
      WHEN NOT (dx > dy AND dx > dz) AND dz > dy THEN -rx - ry ELSE rz END AS raw_r
  FROM errors
), keyed AS (
  SELECT *, CAST(mod(mod(raw_q, {columns}) + {columns}, {columns}) AS BIGINT) AS q,
    CAST(raw_r AS BIGINT) AS r FROM assigned
), centered AS (
  SELECT *, mod(mod(CAST({step} AS DOUBLE) * (q + CASE WHEN {mode_hex} = 1 THEN r / 2.0 ELSE 0 END), {world}) + {world}, {world}) - {half_world} AS center_x
  FROM keyed
), local_points AS (
  SELECT *, center_x + mod(mod(x - center_x, {world}) + {world}, {world}) - {half_world} AS local_x
  FROM centered
), grouped AS (
  SELECT q, r, table_id, count(*) AS n, sum(local_x) AS sum_x, sum(y) AS sum_y,
    min(local_x) AS min_x, min(y) AS min_y, max(local_x) AS max_x, max(y) AS max_y
  FROM local_points GROUP BY q, r, table_id
), ranked_cells AS (
  SELECT *, dense_rank() OVER (ORDER BY q, r) AS cell_rank FROM grouped
)
SELECT q, r, table_id, n, sum_x, sum_y, min_x, min_y, max_x, max_y,
  max(cell_rank) OVER () AS cell_total, sum(n) OVER () AS matched_total
FROM ranked_cells ORDER BY q, r, table_id LIMIT {limit}
