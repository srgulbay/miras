import { getDatabase } from "./db.js";

export async function consumeRateLimit(
  config,
  { scope, subjectHash, limit, windowSeconds },
) {
  const sql = await getDatabase(config);
  const rows = await sql`
    WITH expired AS (
      DELETE FROM rate_limit_buckets
      WHERE ctid IN (
        SELECT ctid
        FROM rate_limit_buckets
        WHERE expires_at < now()
        ORDER BY expires_at
        LIMIT 100
      )
    ),
    bucket AS (
      SELECT to_timestamp(
        floor(extract(epoch FROM clock_timestamp()) / ${windowSeconds}) * ${windowSeconds}
      ) AS starts_at
    ),
    consumed AS (
      INSERT INTO rate_limit_buckets (
        scope,
        subject_hash,
        window_start,
        hit_count,
        expires_at
      )
      SELECT
        ${scope},
        ${subjectHash},
        starts_at,
        1,
        starts_at + make_interval(secs => ${windowSeconds * 2})
      FROM bucket
      ON CONFLICT (scope, subject_hash, window_start)
      DO UPDATE SET hit_count = LEAST(
        rate_limit_buckets.hit_count + 1,
        ${limit + 1}
      )
      RETURNING hit_count, window_start
    )
    SELECT
      hit_count,
      GREATEST(
        1,
        ceil(extract(epoch FROM (
          window_start + make_interval(secs => ${windowSeconds}) - clock_timestamp()
        )))
      )::integer AS retry_after
    FROM consumed
  `;

  const row = rows[0];
  return {
    allowed: Number(row.hit_count) <= limit,
    retryAfter: Number(row.retry_after),
  };
}
