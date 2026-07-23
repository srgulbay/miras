export class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (message, code = "GECERSIZ_ISTEK") =>
  new ApiError(400, code, message);

export const unauthorized = (message = "Bu işlem için geçerli anonim oturum bulunamadı.") =>
  new ApiError(401, "OTURUM_GEREKLI", message);

export const forbidden = (message = "Bu isteğin kaynağı doğrulanamadı.") =>
  new ApiError(403, "KAYNAK_DOGRULANAMADI", message);

export const notFound = (message = "İstenen kayıt bulunamadı.") =>
  new ApiError(404, "BULUNAMADI", message);

export const conflict = (message) =>
  new ApiError(409, "CAKISMA", message);

export const unsupportedMedia = () =>
  new ApiError(415, "DESTEKLENMEYEN_ORTAM", "İstek gövdesi JSON biçiminde olmalıdır.");

export const unprocessable = (message, code = "DOGRULAMA_HATASI") =>
  new ApiError(422, code, message);

export const tooManyRequests = (retryAfter) =>
  new ApiError(
    429,
    "COK_FAZLA_ISTEK",
    "Çok sık işlem yaptınız. Lütfen kısa bir süre sonra yeniden deneyin.",
    { "Retry-After": String(Math.max(1, Math.ceil(retryAfter))) },
  );

export const unavailable = () =>
  new ApiError(
    503,
    "HIZMET_GECICI_OLARAK_KULLANILAMIYOR",
    "Hizmet şu anda kullanılamıyor. Lütfen biraz sonra yeniden deneyin.",
  );
