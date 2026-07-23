BEGIN;

SELECT pg_advisory_xact_lock(hashtext('miras-community-schema-v1'));

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracks (
  slug varchar(80) PRIMARY KEY,
  position smallint NOT NULL UNIQUE CHECK (position BETWEEN 1 AND 99),
  title varchar(120) NOT NULL,
  variant varchar(60),
  is_published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS album_stats (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  plays bigint NOT NULL DEFAULT 0 CHECK (plays >= 0),
  likes bigint NOT NULL DEFAULT 0 CHECK (likes >= 0),
  comments bigint NOT NULL DEFAULT 0 CHECK (comments >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS track_stats (
  track_slug varchar(80) PRIMARY KEY REFERENCES tracks(slug) ON DELETE RESTRICT,
  plays bigint NOT NULL DEFAULT 0 CHECK (plays >= 0),
  comments bigint NOT NULL DEFAULT 0 CHECK (comments >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS album_likes (
  actor_hash char(64) PRIMARY KEY CHECK (actor_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listen_sessions (
  id uuid PRIMARY KEY,
  actor_hash char(64) NOT NULL CHECK (actor_hash ~ '^[0-9a-f]{64}$'),
  track_slug varchar(80) NOT NULL REFERENCES tracks(slug) ON DELETE RESTRICT,
  listened_ms integer NOT NULL DEFAULT 0 CHECK (listened_ms BETWEEN 0 AND 30000),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_pulse_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  credited_at timestamptz,
  credit_slot bigint,
  CHECK (last_pulse_at >= started_at),
  CHECK (expires_at > started_at),
  CHECK (credited_at IS NULL OR listened_ms = 30000),
  CHECK ((credited_at IS NULL) = (credit_slot IS NULL))
);

CREATE INDEX IF NOT EXISTS listen_sessions_actor_created_idx
  ON listen_sessions (actor_hash, started_at DESC);
CREATE INDEX IF NOT EXISTS listen_sessions_expiry_idx
  ON listen_sessions (expires_at);
CREATE INDEX IF NOT EXISTS listen_sessions_track_credited_idx
  ON listen_sessions (track_slug, credited_at)
  WHERE credited_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS listen_sessions_hourly_credit_unique_idx
  ON listen_sessions (actor_hash, track_slug, credit_slot)
  WHERE credited_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  actor_hash char(64) NOT NULL CHECK (actor_hash ~ '^[0-9a-f]{64}$'),
  track_slug varchar(80) REFERENCES tracks(slug) ON DELETE RESTRICT,
  display_name varchar(80),
  body varchar(1600) NOT NULL,
  body_hash char(64) NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  status varchar(16) NOT NULL CHECK (status IN ('visible', 'pending', 'deleted')),
  moderation_reason varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (
    display_name IS NULL OR (
      char_length(display_name) BETWEEN 2 AND 80
      AND octet_length(display_name) <= 160
    )
  ),
  CHECK (char_length(body) BETWEEN 3 AND 1600),
  CHECK (octet_length(body) <= 4096),
  CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL)
    OR (status <> 'deleted' AND deleted_at IS NULL)
  ),
  UNIQUE (actor_hash, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS comments_active_body_unique_idx
  ON comments (actor_hash, COALESCE(track_slug, ''), body_hash)
  WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS comments_public_page_idx
  ON comments (created_at DESC, id DESC)
  WHERE status = 'visible' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS comments_track_public_page_idx
  ON comments (track_slug, created_at DESC, id DESC)
  WHERE status = 'visible' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS comments_owner_idx
  ON comments (actor_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope varchar(64) NOT NULL,
  subject_hash char(64) NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  hit_count integer NOT NULL DEFAULT 1 CHECK (hit_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, subject_hash, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry_idx
  ON rate_limit_buckets (expires_at);

INSERT INTO album_stats (singleton)
VALUES (1)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO tracks (slug, position, title, variant) VALUES
  ('01-feryad-akustik', 1, 'Feryad', 'Akustik'),
  ('02-ask-afeti-cihandir', 2, 'Aşk Afeti Cihandır', NULL),
  ('03-kalir', 3, 'Kalır', NULL),
  ('04-bir', 4, 'Bir', NULL),
  ('05-yandi', 5, 'Yandı', NULL),
  ('06-bana-sen-gereksin-sen', 6, 'Bana Sen Gereksin Sen', NULL),
  ('07-ask-afeti-cihandir-classic', 7, 'Aşk Afeti Cihandır', 'Klasik'),
  ('08-kalir-akustik', 8, 'Kalır', 'Akustik'),
  ('09-yandi-akustik', 9, 'Yandı', 'Akustik'),
  ('10-bana-sen-gereksin-akustik', 10, 'Bana Sen Gereksin', 'Akustik'),
  ('11-feryad', 11, 'Feryad', NULL),
  ('12-bir-gun', 12, 'Bir Gün', NULL)
ON CONFLICT (slug) DO UPDATE SET
  position = EXCLUDED.position,
  title = EXCLUDED.title,
  variant = EXCLUDED.variant,
  is_published = true;

INSERT INTO track_stats (track_slug)
SELECT slug
FROM tracks
ON CONFLICT (track_slug) DO NOTHING;

CREATE OR REPLACE FUNCTION update_album_like_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delta integer;
BEGIN
  delta := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
  UPDATE album_stats
  SET likes = GREATEST(0, likes + delta),
      updated_at = now()
  WHERE singleton = 1;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS album_likes_counter_trigger ON album_likes;
CREATE TRIGGER album_likes_counter_trigger
AFTER INSERT OR DELETE ON album_likes
FOR EACH ROW EXECUTE FUNCTION update_album_like_counter();

CREATE OR REPLACE FUNCTION update_listen_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.credited_at IS NULL AND NEW.credited_at IS NOT NULL THEN
    UPDATE album_stats
    SET plays = plays + 1,
        updated_at = now()
    WHERE singleton = 1;

    UPDATE track_stats
    SET plays = plays + 1,
        updated_at = now()
    WHERE track_slug = NEW.track_slug;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS listen_credit_counter_trigger ON listen_sessions;
CREATE TRIGGER listen_credit_counter_trigger
AFTER UPDATE OF credited_at ON listen_sessions
FOR EACH ROW EXECUTE FUNCTION update_listen_counter();

CREATE OR REPLACE FUNCTION update_comment_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_visible boolean := false;
  new_visible boolean := false;
  album_delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_visible := OLD.status = 'visible' AND OLD.deleted_at IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_visible := NEW.status = 'visible' AND NEW.deleted_at IS NULL;
  END IF;

  album_delta := (CASE WHEN new_visible THEN 1 ELSE 0 END)
               - (CASE WHEN old_visible THEN 1 ELSE 0 END);

  IF album_delta <> 0 THEN
    UPDATE album_stats
    SET comments = GREATEST(0, comments + album_delta),
        updated_at = now()
    WHERE singleton = 1;
  END IF;

  IF old_visible AND OLD.track_slug IS NOT NULL THEN
    UPDATE track_stats
    SET comments = GREATEST(0, comments - 1),
        updated_at = now()
    WHERE track_slug = OLD.track_slug;
  END IF;

  IF new_visible AND NEW.track_slug IS NOT NULL THEN
    UPDATE track_stats
    SET comments = comments + 1,
        updated_at = now()
    WHERE track_slug = NEW.track_slug;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS comments_counter_trigger ON comments;
CREATE TRIGGER comments_counter_trigger
AFTER INSERT OR UPDATE OF status, deleted_at, track_slug OR DELETE ON comments
FOR EACH ROW EXECUTE FUNCTION update_comment_counter();

INSERT INTO schema_migrations (version)
VALUES ('001-community-core')
ON CONFLICT (version) DO NOTHING;

COMMIT;
