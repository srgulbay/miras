import { signCompactToken, verifyCompactToken } from "./crypto.js";
import { unprocessable } from "./errors.js";
import { validateTrackSlug } from "./tracks.js";
import { validateUuid } from "./validation.js";

const TOKEN_PURPOSE = "listen-session";

export function issueListenToken(config, session) {
  return signCompactToken(config.communitySecret, TOKEN_PURPOSE, {
    sid: session.id,
    trackSlug: session.trackSlug,
  });
}

export function verifyListenToken(config, token) {
  const payload = verifyCompactToken(config.communitySecret, TOKEN_PURPOSE, token);
  if (!payload) throw unprocessable("Dinleme oturumu geçerli değil.", "GECERSIZ_DINLEME_OTURUMU");

  return {
    id: validateUuid(payload.sid, "Dinleme oturumu"),
    trackSlug: validateTrackSlug(payload.trackSlug),
  };
}
