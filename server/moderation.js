import { sha256Hex } from "./crypto.js";
import { unprocessable } from "./errors.js";

const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const URL_OR_CONTACT = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d\s().-]{8,}\d)|\b(?:t\.me|wa\.me)\b)/iu;
const HTMLISH = /<\/?[a-z][^>]*>|&#?\w+;/iu;
const SPAM_TERMS = /\b(?:casino|bahis|bonus|telegram|whatsapp|kripto\s*sinyal|takipçi\s*satın)\b/iu;
const PROFANITY = /\b(?:orospu|sik(?:ik|eyim|tir)?|amk|piç|ibne)\b/iu;
const REPEATED_CHARACTER = /(.)\1{7,}/iu;
const REPEATED_WORD = /\b([\p{L}\p{N}]{2,})\b(?:[\s,.;:!?-]+\1\b){3,}/iu;

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("tr", { granularity: "grapheme" })
  : null;

function graphemeLength(value) {
  return segmenter ? [...segmenter.segment(value)].length : [...value].length;
}

function normalizeMultiline(value) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validatePlainText(value, field, min, max, maxBytes) {
  if (typeof value !== "string") {
    throw unprocessable(`${field} metin olmalıdır.`);
  }
  if (FORBIDDEN_CONTROLS.test(value)) {
    throw unprocessable(`${field} desteklenmeyen kontrol karakterleri içeriyor.`);
  }

  const normalized = normalizeMultiline(value);
  const length = graphemeLength(normalized);
  if (length < min || length > max || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw unprocessable(`${field} ${min}-${max} karakter arasında olmalıdır.`);
  }
  return normalized;
}

function hasExcessiveUppercase(value) {
  const letters = [...value].filter((char) => /\p{L}/u.test(char));
  if (letters.length < 16) return false;
  const uppercase = letters.filter(
    (char) => char === char.toLocaleUpperCase("tr") && char !== char.toLocaleLowerCase("tr"),
  );
  return uppercase.length / letters.length > 0.75;
}

export function prepareComment(input) {
  const displayName =
    input.displayName === null || input.displayName === undefined || input.displayName === ""
      ? null
      : validatePlainText(input.displayName, "Görünen ad", 2, 40, 160).replace(/\n/g, " ");
  const body = validatePlainText(input.body, "Yorum", 3, 800, 4_096);

  const reasons = [];
  const combined = `${displayName || ""}\n${body}`;
  if (URL_OR_CONTACT.test(combined)) reasons.push("iletisim_veya_baglanti");
  if (HTMLISH.test(combined)) reasons.push("isaretleme");
  if (SPAM_TERMS.test(combined)) reasons.push("spam_ifadesi");
  if (PROFANITY.test(combined)) reasons.push("uygunsuz_ifade");
  if (REPEATED_CHARACTER.test(body) || REPEATED_WORD.test(body)) reasons.push("tekrar");
  if (hasExcessiveUppercase(body)) reasons.push("asiri_buyuk_harf");
  if (typeof input.website === "string" && input.website.trim()) reasons.push("honeypot");

  return {
    displayName,
    body,
    status: reasons.length ? "pending" : "visible",
    moderationReason: reasons[0] || null,
  };
}

export function commentBodyHash(trackSlug, body) {
  return sha256Hex(`${trackSlug || "album"}\0${body.toLocaleLowerCase("tr")}`);
}
