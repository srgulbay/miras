import { unavailable } from "./errors.js";

const MIN_SECRET_BYTES = 32;

function requireSecret(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES ||
    /^replace-with-/i.test(value)
  ) {
    throw unavailable();
  }
  return value;
}

export function getRuntimeConfig(env = process.env) {
  return Object.freeze({
    databaseUrl:
      typeof env.DATABASE_URL === "string" && env.DATABASE_URL.startsWith("postgres")
        ? env.DATABASE_URL
        : null,
    communitySecret: requireSecret(env.COMMUNITY_SECRET),
    cookieMaxAge: 31_536_000,
    listenHeartbeatMs: 10_000,
    listenPulseCapMs: 10_000,
    listenTargetMs: 30_000,
    listenSessionTtlSeconds: 20 * 60,
  });
}

export function requireDatabaseUrl(config) {
  if (!config.databaseUrl) throw unavailable();
  return config.databaseUrl;
}
