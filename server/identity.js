import {
  hmacBase64Url,
  hmacHex,
  randomId,
  safeEqualBase64Url,
} from "./crypto.js";

const COOKIE_VERSION = "v1";
const ANON_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function cookieSettings(request) {
  const secure = new URL(request.url).protocol === "https:";
  return {
    name: secure ? "__Host-miras_anon" : "miras_anon",
    secure,
  };
}

export function issueAnonymousCookie(request, config) {
  const cookie = cookieSettings(request);
  const id = randomId(16);
  const signed = `${COOKIE_VERSION}.${id}`;
  const signature = hmacBase64Url(config.communitySecret, "anon-cookie", signed);
  const value = `${signed}.${signature}`;
  const header = [
    `${cookie.name}=${value}`,
    "Path=/",
    "HttpOnly",
    ...(cookie.secure ? ["Secure"] : []),
    "SameSite=Strict",
    `Max-Age=${config.cookieMaxAge}`,
  ].join("; ");
  return { id, value, header };
}

export function verifyAnonymousCookie(config, value) {
  if (typeof value !== "string" || value.length > 256) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION || !ANON_ID_RE.test(parts[1])) {
    return null;
  }
  const expected = hmacBase64Url(
    config.communitySecret,
    "anon-cookie",
    `${parts[0]}.${parts[1]}`,
  );
  return safeEqualBase64Url(parts[2], expected) ? parts[1] : null;
}

export function getAnonymousIdentity(request, config, { create = false } = {}) {
  const cookie = cookieSettings(request);
  const value = parseCookies(request.headers.get("cookie")).get(cookie.name);
  let id = verifyAnonymousCookie(config, value);
  let setCookie = null;

  if (!id && create) {
    const issued = issueAnonymousCookie(request, config);
    id = issued.id;
    setCookie = issued.header;
  }

  if (!id) return null;

  return {
    setCookie,
    subject(purpose) {
      return hmacHex(config.communitySecret, `actor:${purpose}`, id);
    },
  };
}

export function getRequestIpHash(request, config, now = new Date()) {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for");
  if (!forwarded) return null;

  const raw = forwarded.split(",")[0]?.trim();
  if (!raw || raw.length > 64 || /[\s\r\n]/.test(raw)) return null;

  const day = now.toISOString().slice(0, 10);
  return hmacHex(config.communitySecret, "rate-limit-ip", `${day}:${raw}`);
}
