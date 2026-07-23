import { neon } from "@neondatabase/serverless";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const databaseUrl = process.env.DATABASE_URL;
const [action = "list", rawId] = process.argv.slice(2);

if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
  console.error("Moderasyon durduruldu: DATABASE_URL tanımlı değil.");
  process.exitCode = 1;
} else if (!["list", "approve", "remove"].includes(action)) {
  console.error("Kullanım: list | approve <yorum-id> | remove <yorum-id>");
  process.exitCode = 1;
} else if (action !== "list" && !UUID_RE.test(rawId || "")) {
  console.error("Moderasyon durduruldu: geçerli bir yorum kimliği gerekli.");
  process.exitCode = 1;
} else {
  const sql = neon(databaseUrl);

  try {
    if (action === "list") {
      const rows = await sql`
        SELECT
          id,
          display_name AS "name",
          track_slug AS "trackSlug",
          body,
          moderation_reason AS "reason",
          created_at AS "createdAt"
        FROM comments
        WHERE status = 'pending'
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT 100
      `;
      console.log(JSON.stringify({ pending: rows }, null, 2));
    } else if (action === "approve") {
      const rows = await sql`
        UPDATE comments
        SET status = 'visible',
            moderation_reason = NULL
        WHERE id = ${rawId.toLowerCase()}
          AND status = 'pending'
          AND deleted_at IS NULL
        RETURNING id
      `;
      if (!rows[0]) throw new Error("Yorum bulunamadı veya beklemede değil.");
      console.log(`Yorum yayımlandı: ${rows[0].id}`);
    } else {
      const rows = await sql`
        UPDATE comments
        SET status = 'deleted',
            deleted_at = now()
        WHERE id = ${rawId.toLowerCase()}
          AND status <> 'deleted'
          AND deleted_at IS NULL
        RETURNING id
      `;
      if (!rows[0]) throw new Error("Yorum bulunamadı veya zaten silinmiş.");
      console.log(`Yorum kaldırıldı: ${rows[0].id}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Moderasyon işlemi tamamlanamadı.");
    process.exitCode = 1;
  }
}
