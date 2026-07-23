import {
  ApiError,
  badRequest,
  forbidden,
  unavailable,
  unsupportedMedia,
} from "./errors.js";

const JSON_TYPE_RE = /^application\/json(?:\s*;|$)/i;
const DEFAULT_BODY_LIMIT = 8 * 1024;

export function jsonResponse(status, message, data, options = {}) {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "Pragma": "no-cache",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    ...options.headers,
  });
  if (options.setCookie) headers.append("Set-Cookie", options.setCookie);

  const body = options.ok === false
    ? { ok: false, message, code: options.code || "ISTEK_BASARISIZ" }
    : { ok: true, message, ...(data === undefined ? {} : data) };

  return new Response(JSON.stringify(body), { status, headers });
}

export function assertSameOriginMutation(request) {
  let requestOrigin;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw forbidden();
  }

  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || origin !== requestOrigin) throw forbidden();

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw forbidden();
}

export async function readJson(request, limit = DEFAULT_BODY_LIMIT) {
  const contentType = request.headers.get("content-type") || "";
  if (!JSON_TYPE_RE.test(contentType)) throw unsupportedMedia();

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw badRequest("İstek gövdesi izin verilen boyutu aşıyor.", "GOVDE_COK_BUYUK");
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw badRequest("İstek gövdesi izin verilen boyutu aşıyor.", "GOVDE_COK_BUYUK");
  }
  if (!text.trim()) throw badRequest("İstek gövdesi boş olamaz.");

  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw badRequest("İstek gövdesi geçerli JSON değil.", "GECERSIZ_JSON");
  }
}

export function safeHandler(handler) {
  return async function guardedHandler(request) {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonResponse(error.status, error.message, undefined, {
          ok: false,
          code: error.code,
          headers: error.headers,
        });
      }
      return jsonResponse(unavailable().status, unavailable().message, undefined, {
        ok: false,
        code: unavailable().code,
      });
    }
  };
}
