import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function hmacBase64Url(secret, purpose, value) {
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`, "utf8")
    .digest("base64url");
}

export function hmacHex(secret, purpose, value) {
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`, "utf8")
    .digest("hex");
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomId(bytes = 16) {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqualBase64Url(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !B64URL_RE.test(left) ||
    !B64URL_RE.test(right)
  ) {
    return false;
  }

  try {
    const a = Buffer.from(left, "base64url");
    const b = Buffer.from(right, "base64url");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signCompactToken(secret, purpose, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = hmacBase64Url(secret, purpose, `v1.${encoded}`);
  return `v1.${encoded}.${signature}`;
}

export function verifyCompactToken(secret, purpose, token) {
  if (typeof token !== "string" || token.length > 2_048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !B64URL_RE.test(parts[1])) return null;

  const signed = `v1.${parts[1]}`;
  const expected = hmacBase64Url(secret, purpose, signed);
  if (!safeEqualBase64Url(parts[2], expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}
