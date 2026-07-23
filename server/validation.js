import { badRequest, unprocessable } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function validateUuid(value, field = "Kimlik") {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw unprocessable(`${field} geçerli değil.`);
  }
  return value.toLowerCase();
}

export function parseLimit(value, fallback = 12, maximum = 30) {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,3}$/.test(value)) throw badRequest("Sayfa boyutu geçerli değil.");
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum) {
    throw badRequest(`Sayfa boyutu 1-${maximum} arasında olmalıdır.`);
  }
  return parsed;
}

export function encodeCursor(comment) {
  const createdAt = comment?._cursorCreatedAt || comment?.createdAt;
  return Buffer.from(
    JSON.stringify({ createdAt, id: comment.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw badRequest("Yorum sayfalama bilgisi geçerli değil.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.createdAt !== "string" ||
      !CURSOR_TIME_RE.test(parsed.createdAt) ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      !UUID_RE.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.createdAt, id: parsed.id.toLowerCase() };
  } catch {
    throw badRequest("Yorum sayfalama bilgisi geçerli değil.");
  }
}
