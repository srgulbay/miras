import { getDatabase } from "./db.js";
import { getTrackLabel } from "./tracks.js";

function count(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : String(value);
}

function mapComment(row) {
  const comment = {
    id: row.id,
    trackSlug: row.track_slug,
    trackLabel: getTrackLabel(row.track_slug),
    name: row.display_name || "Misafir",
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    owned: Boolean(row.owned),
  };
  Object.defineProperty(comment, "_cursorCreatedAt", {
    value: row.cursor_created_at || comment.createdAt,
    enumerable: false,
  });
  return comment;
}

export async function getEngagement(config, actorHash = null) {
  const sql = await getDatabase(config);
  const rows = await sql`
    SELECT
      a.plays::text,
      a.likes::text,
      a.comments::text,
      (
        ${actorHash}::text IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM album_likes l
          WHERE l.actor_hash = ${actorHash}
        )
      ) AS liked,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'trackSlug', t.slug,
              'plays', s.plays::text,
              'likes', s.likes::text,
              'comments', s.comments::text,
              'liked', (
                ${actorHash}::text IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM track_likes l
                  WHERE l.actor_hash = ${actorHash}
                    AND l.track_slug = t.slug
                )
              )
            )
            ORDER BY t.position
          )
          FROM tracks t
          JOIN track_stats s ON s.track_slug = t.slug
          WHERE t.is_published = true
        ),
        '[]'::jsonb
      ) AS tracks
    FROM album_stats a
    WHERE a.singleton = 1
  `;

  const album = rows[0] || {
    plays: 0,
    likes: 0,
    comments: 0,
    liked: false,
    tracks: [],
  };
  return {
    plays: count(album.plays),
    likes: count(album.likes),
    comments: count(album.comments),
    liked: Boolean(album.liked),
    tracks: (Array.isArray(album.tracks) ? album.tracks : []).map((track) => ({
      trackSlug: track.trackSlug,
      plays: count(track.plays),
      likes: count(track.likes),
      comments: count(track.comments),
      liked: Boolean(track.liked),
    })),
  };
}

export async function setAlbumLike(config, actorHash, liked) {
  const sql = await getDatabase(config);
  if (liked) {
    await sql`
      INSERT INTO album_likes (actor_hash)
      VALUES (${actorHash})
      ON CONFLICT (actor_hash) DO NOTHING
    `;
  } else {
    await sql`
      DELETE FROM album_likes
      WHERE actor_hash = ${actorHash}
    `;
  }

  const rows = await sql`
    SELECT
      s.likes::text,
      EXISTS (
        SELECT 1 FROM album_likes WHERE actor_hash = ${actorHash}
      ) AS liked
    FROM album_stats s
    WHERE s.singleton = 1
  `;
  return {
    liked: Boolean(rows[0]?.liked),
    likes: count(rows[0]?.likes ?? 0),
  };
}

export async function setTrackLike(config, actorHash, trackSlug, liked) {
  const sql = await getDatabase(config);
  if (liked) {
    await sql`
      INSERT INTO track_likes (actor_hash, track_slug)
      VALUES (${actorHash}, ${trackSlug})
      ON CONFLICT (actor_hash, track_slug) DO NOTHING
    `;
  } else {
    await sql`
      DELETE FROM track_likes
      WHERE actor_hash = ${actorHash}
        AND track_slug = ${trackSlug}
    `;
  }

  const rows = await sql`
    SELECT
      s.likes::text,
      EXISTS (
        SELECT 1
        FROM track_likes
        WHERE actor_hash = ${actorHash}
          AND track_slug = ${trackSlug}
      ) AS liked
    FROM track_stats s
    WHERE s.track_slug = ${trackSlug}
  `;
  return {
    trackSlug,
    liked: Boolean(rows[0]?.liked),
    likes: count(rows[0]?.likes ?? 0),
  };
}

export async function createListenSession(
  config,
  { id, actorHash, trackSlug, ttlSeconds },
) {
  const sql = await getDatabase(config);
  const rows = await sql`
    WITH expired AS (
      DELETE FROM listen_sessions
      WHERE ctid IN (
        SELECT ctid
        FROM listen_sessions
        WHERE expires_at < now() - interval '1 day'
        ORDER BY expires_at
        LIMIT 100
      )
    )
    INSERT INTO listen_sessions (
      id,
      actor_hash,
      track_slug,
      expires_at
    )
    VALUES (
      ${id},
      ${actorHash},
      ${trackSlug},
      now() + make_interval(secs => ${ttlSeconds})
    )
    ON CONFLICT (id) DO UPDATE
    SET id = listen_sessions.id
    WHERE listen_sessions.actor_hash = EXCLUDED.actor_hash
      AND listen_sessions.track_slug = EXCLUDED.track_slug
      AND listen_sessions.expires_at > statement_timestamp()
    RETURNING id, track_slug
  `;
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    trackSlug: rows[0].track_slug,
  };
}

export async function pulseListenSession(
  config,
  { id, actorHash, trackSlug, pulseCapMs, targetMs },
) {
  const sql = await getDatabase(config);
  const rows = await sql`
    WITH target AS MATERIALIZED (
      SELECT
        id,
        listened_ms,
        last_pulse_at,
        credited_at
      FROM listen_sessions
      WHERE id = ${id}
        AND actor_hash = ${actorHash}
        AND track_slug = ${trackSlug}
        AND expires_at > statement_timestamp()
      FOR UPDATE
    ),
    advanced AS (
      SELECT
        id,
        credited_at,
        LEAST(
          ${targetMs}::integer,
          listened_ms + LEAST(
            ${pulseCapMs}::integer,
            GREATEST(
              0,
              floor(
                extract(epoch FROM (statement_timestamp() - last_pulse_at)) * 1000
              )::integer
            )
          )
        ) AS next_listened_ms
      FROM target
    ),
    updated AS (
      UPDATE listen_sessions s
      SET
        listened_ms = a.next_listened_ms,
        last_pulse_at = statement_timestamp()
      FROM advanced a
      WHERE s.id = a.id
      RETURNING
        s.listened_ms,
        s.credited_at
    )
    SELECT listened_ms, credited_at
    FROM updated
  `;

  if (!rows[0]) return null;

  let countedNow = false;
  let deduplicated = false;
  let creditedAt = rows[0].credited_at;
  if (!creditedAt && Number(rows[0].listened_ms) >= targetMs) {
    try {
      const credited = await sql`
        UPDATE listen_sessions
        SET
          credited_at = statement_timestamp(),
          credit_slot = floor(
            extract(epoch FROM statement_timestamp()) / 3600
          )::bigint
        WHERE id = ${id}
          AND actor_hash = ${actorHash}
          AND track_slug = ${trackSlug}
          AND credited_at IS NULL
          AND expires_at > statement_timestamp()
        RETURNING credited_at
      `;
      if (credited[0]) {
        countedNow = true;
        creditedAt = credited[0].credited_at;
      } else {
        const current = await sql`
          SELECT credited_at
          FROM listen_sessions
          WHERE id = ${id}
            AND actor_hash = ${actorHash}
            AND track_slug = ${trackSlug}
        `;
        creditedAt = current[0]?.credited_at || null;
      }
    } catch (error) {
      const code = error?.code || error?.cause?.code;
      if (code !== "23505") throw error;
      deduplicated = true;
    }
  }

  const stats = await sql`
    SELECT
      a.plays::text AS album_plays,
      t.plays::text AS track_plays
    FROM album_stats a
    JOIN track_stats t ON t.track_slug = ${trackSlug}
    WHERE a.singleton = 1
  `;

  return {
    counted: countedNow,
    credited: Boolean(creditedAt),
    deduplicated,
    accumulatedMs: Number(rows[0].listened_ms),
    plays: count(stats[0]?.album_plays ?? 0),
    trackPlays: count(stats[0]?.track_plays ?? 0),
  };
}

export async function listComments(
  config,
  { trackSlug = null, cursor = null, limit, viewerActorHash = null },
) {
  const sql = await getDatabase(config);
  const cursorDate = cursor?.createdAt || null;
  const cursorId = cursor?.id || null;
  const rows = await sql`
    SELECT
      id,
      track_slug,
      display_name,
      body,
      created_at,
      to_char(
        created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS cursor_created_at,
      (
        ${viewerActorHash}::text IS NOT NULL
        AND actor_hash = ${viewerActorHash}
      ) AS owned
    FROM comments
    WHERE status = 'visible'
      AND deleted_at IS NULL
      AND (${trackSlug}::text IS NULL OR track_slug = ${trackSlug})
      AND (
        ${cursorDate}::timestamptz IS NULL
        OR (created_at, id) < (${cursorDate}::timestamptz, ${cursorId}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.map(mapComment);
}

export async function createComment(
  config,
  {
    id,
    requestId,
    actorHash,
    trackSlug,
    displayName,
    body,
    bodyHash,
    status,
    moderationReason,
  },
) {
  const sql = await getDatabase(config);
  const inserted = await sql`
    INSERT INTO comments (
      id,
      request_id,
      actor_hash,
      track_slug,
      display_name,
      body,
      body_hash,
      status,
      moderation_reason
    )
    VALUES (
      ${id},
      ${requestId},
      ${actorHash},
      ${trackSlug},
      ${displayName},
      ${body},
      ${bodyHash},
      ${status},
      ${moderationReason}
    )
    ON CONFLICT DO NOTHING
    RETURNING id, track_slug, display_name, body, status, created_at
  `;

  if (inserted[0]) {
    return {
      ...mapComment(inserted[0]),
      status: inserted[0].status,
      created: true,
      owned: true,
    };
  }

  const existing = await sql`
    SELECT id, track_slug, display_name, body, status, created_at
    FROM comments
    WHERE actor_hash = ${actorHash}
      AND status <> 'deleted'
      AND (
        request_id = ${requestId}
        OR (
          COALESCE(track_slug, '') = COALESCE(${trackSlug}::text, '')
          AND body_hash = ${bodyHash}
        )
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!existing[0]) return null;
  return {
    ...mapComment(existing[0]),
    status: existing[0].status,
    created: false,
    owned: true,
  };
}

export async function deleteOwnedComment(config, { id, actorHash }) {
  const sql = await getDatabase(config);
  const rows = await sql`
    UPDATE comments
    SET status = 'deleted',
        deleted_at = now()
    WHERE id = ${id}
      AND actor_hash = ${actorHash}
      AND status <> 'deleted'
      AND deleted_at IS NULL
    RETURNING id
  `;
  return Boolean(rows[0]);
}
