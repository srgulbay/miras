import { requireDatabaseUrl } from "./config.js";

let cachedDatabaseUrl = null;
let cachedSql = null;
let testSql = null;

export function setDatabaseForTests(sql) {
  testSql = sql;
}

export function resetDatabaseForTests() {
  testSql = null;
}

export async function getDatabase(config) {
  if (testSql) return testSql;
  const databaseUrl = requireDatabaseUrl(config);
  if (cachedSql && cachedDatabaseUrl === databaseUrl) return cachedSql;

  const { neon } = await import("@neondatabase/serverless");
  cachedDatabaseUrl = databaseUrl;
  cachedSql = neon(databaseUrl);
  return cachedSql;
}
