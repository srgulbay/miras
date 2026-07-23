import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
  console.error("Migration durduruldu: DATABASE_URL tanımlı değil.");
  process.exitCode = 1;
} else {
  neonConfig.webSocketConstructor = ws;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(here, "../db/schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(schema);
    console.log("MİRAS veritabanı şeması güncel.");
  } catch {
    console.error("Migration tamamlanamadı. Bağlantıyı ve veritabanı yetkilerini kontrol edin.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
