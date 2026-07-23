import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "./config.js";
import {
  conflict,
  notFound,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from "./errors.js";
import {
  assertSameOriginMutation,
  jsonResponse,
  readJson,
  safeHandler,
} from "./http.js";
import {
  getAnonymousIdentity,
  getRequestIpHash,
} from "./identity.js";
import {
  issueListenToken,
  verifyListenToken,
} from "./listen-token.js";
import {
  commentBodyHash,
  prepareComment,
} from "./moderation.js";
import { consumeRateLimit } from "./rate-limit.js";
import * as liveRepository from "./repository.js";
import { validateTrackSlug } from "./tracks.js";
import {
  decodeCursor,
  encodeCursor,
  parseLimit,
  validateUuid,
} from "./validation.js";

const RATE_RULES = Object.freeze({
  like: { actor: [30, 3_600], ip: [200, 3_600] },
  listenStart: { actor: [40, 3_600], ip: [200, 3_600] },
  listenPulse: { actor: [300, 3_600], ip: [1_000, 3_600] },
  commentPost: { actor: [3, 3_600], ip: [20, 3_600] },
  commentDelete: { actor: [20, 3_600], ip: [100, 3_600] },
});

function resolveConfig(source) {
  return typeof source === "function" ? source() : source;
}

export function createApplication(overrides = {}) {
  const repository = overrides.repository || liveRepository;
  const rateLimiter = overrides.rateLimiter || consumeRateLimit;
  const configSource = overrides.config || getRuntimeConfig;
  const createUuid = overrides.randomUUID || randomUUID;
  const now = overrides.now || (() => new Date());

  async function enforceRateLimit(request, config, identity, scope, rules) {
    const subjects = [
      {
        scope: `${scope}:actor`,
        subjectHash: identity.subject(`rate:${scope}`),
        limit: rules.actor[0],
        windowSeconds: rules.actor[1],
      },
    ];
    const ipHash = getRequestIpHash(request, config, now());
    if (ipHash) {
      subjects.push({
        scope: `${scope}:ip`,
        subjectHash: ipHash,
        limit: rules.ip[0],
        windowSeconds: rules.ip[1],
      });
    }

    for (const rule of subjects) {
      const result = await rateLimiter(config, rule);
      if (!result.allowed) throw tooManyRequests(result.retryAfter);
    }
  }

  const engagementGet = safeHandler(async (request) => {
    const config = resolveConfig(configSource);
    const identity = getAnonymousIdentity(request, config);
    const result = await repository.getEngagement(
      config,
      identity?.subject("like") || null,
    );
    return jsonResponse(200, "Albüm etkileşim bilgileri getirildi.", {
      counts: {
        plays: result.plays,
        likes: result.likes,
        comments: result.comments,
      },
      liked: result.liked,
      tracks: result.tracks,
    });
  });

  const likesPut = safeHandler(async (request) => {
    assertSameOriginMutation(request);
    const body = await readJson(request);
    if (typeof body.liked !== "boolean") {
      throw unprocessable("Beğeni durumu doğru veya yanlış olmalıdır.");
    }
    const hasTrackSlug = Object.prototype.hasOwnProperty.call(body, "trackSlug");
    const trackSlug = hasTrackSlug ? validateTrackSlug(body.trackSlug) : null;

    const config = resolveConfig(configSource);
    const identity = getAnonymousIdentity(request, config, { create: true });
    await enforceRateLimit(request, config, identity, "like", RATE_RULES.like);
    const actorHash = identity.subject("like");
    const result = trackSlug
      ? await repository.setTrackLike(config, actorHash, trackSlug, body.liked)
      : await repository.setAlbumLike(config, actorHash, body.liked);
    const message = trackSlug
      ? result.liked
        ? "Parça beğenildi."
        : "Parça beğenisi kaldırıldı."
      : result.liked
        ? "Albüm beğenildi."
        : "Albüm beğenisi kaldırıldı.";
    return jsonResponse(
      200,
      message,
      result,
      { setCookie: identity.setCookie },
    );
  });

  const listensPost = safeHandler(async (request) => {
    assertSameOriginMutation(request);
    const body = await readJson(request);
    const config = resolveConfig(configSource);

    if (body.action === "start") {
      const trackSlug = validateTrackSlug(body.trackSlug);
      const identity = getAnonymousIdentity(request, config, { create: true });
      await enforceRateLimit(
        request,
        config,
        identity,
        "listen-start",
        RATE_RULES.listenStart,
      );

      const idempotencyKey = request.headers.get("idempotency-key");
      const sessionId = idempotencyKey
        ? validateUuid(idempotencyKey, "Tekrarlama anahtarı")
        : createUuid();
      const session = await repository.createListenSession(config, {
        id: sessionId,
        actorHash: identity.subject("listen"),
        trackSlug,
        ttlSeconds: config.listenSessionTtlSeconds,
      });
      if (!session) {
        throw conflict("Dinleme oturumu başlatılamadı. Lütfen yeniden deneyin.");
      }
      const token = issueListenToken(config, session);
      return jsonResponse(
        201,
        "Dinleme takibi başlatıldı.",
        {
          token,
          thresholdMs: config.listenTargetMs,
          heartbeatMs: config.listenHeartbeatMs,
        },
        { setCookie: identity.setCookie },
      );
    }

    if (body.action === "pulse") {
      const identity = getAnonymousIdentity(request, config);
      if (!identity) throw unauthorized();
      const session = verifyListenToken(config, body.token);
      await enforceRateLimit(
        request,
        config,
        identity,
        "listen-pulse",
        RATE_RULES.listenPulse,
      );

      const result = await repository.pulseListenSession(config, {
        id: session.id,
        actorHash: identity.subject("listen"),
        trackSlug: session.trackSlug,
        pulseCapMs: config.listenPulseCapMs,
        targetMs: config.listenTargetMs,
      });
      if (!result) {
        throw notFound("Dinleme oturumu bulunamadı veya süresi doldu.");
      }

      const message = result.counted
        ? "Dinlenmeniz albüm sayacına eklendi."
        : result.deduplicated
          ? "Bu saat aralığındaki dinleme daha önce sayıldı."
          : result.credited
            ? "Dinleme daha önce sayıldı."
            : "Dinleme süresi güncellendi.";
      return jsonResponse(200, message, {
        counted: result.counted,
        plays: result.plays,
        trackPlays: result.trackPlays,
        accumulatedMs: result.accumulatedMs,
        thresholdMs: config.listenTargetMs,
      });
    }

    throw unprocessable("Dinleme işlemi 'start' veya 'pulse' olmalıdır.");
  });

  const commentsGet = safeHandler(async (request) => {
    const config = resolveConfig(configSource);
    const url = new URL(request.url);
    const trackSlug = validateTrackSlug(url.searchParams.get("trackSlug"), {
      optional: true,
    });
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const identity = getAnonymousIdentity(request, config);
    const rows = await repository.listComments(config, {
      trackSlug,
      cursor,
      limit: limit + 1,
      viewerActorHash: identity?.subject("comment") || null,
    });
    const hasMore = rows.length > limit;
    const comments = rows.slice(0, limit);
    const nextCursor = hasMore && comments.length
      ? encodeCursor(comments[comments.length - 1])
      : null;

    return jsonResponse(200, "Yorumlar getirildi.", { comments, nextCursor });
  });

  const commentsPost = safeHandler(async (request) => {
    assertSameOriginMutation(request);
    const body = await readJson(request);
    const config = resolveConfig(configSource);
    const identity = getAnonymousIdentity(request, config, { create: true });
    const trackSlug = validateTrackSlug(body.trackSlug, { optional: true });
    const prepared = prepareComment({
      displayName: body.name ?? body.displayName,
      body: body.body,
      website: body.website,
    });
    await enforceRateLimit(
      request,
      config,
      identity,
      "comment-post",
      RATE_RULES.commentPost,
    );

    const idempotencyKey = request.headers.get("idempotency-key");
    const requestId = idempotencyKey
      ? validateUuid(idempotencyKey, "Tekrarlama anahtarı")
      : createUuid();
    const result = await repository.createComment(config, {
      id: createUuid(),
      requestId,
      actorHash: identity.subject("comment"),
      trackSlug,
      displayName: prepared.displayName,
      body: prepared.body,
      bodyHash: commentBodyHash(trackSlug, prepared.body),
      status: prepared.status,
      moderationReason: prepared.moderationReason,
    });
    if (!result) {
      throw conflict("Yorum kaydedilemedi. Lütfen yeniden deneyin.");
    }

    const message = result.status === "visible"
      ? result.created
        ? "Yorumunuz yayımlandı."
        : "Bu yorum daha önce gönderildi."
      : result.created
        ? "Yorumunuz incelenmek üzere alındı."
        : "Bu yorum daha önce incelenmek üzere alındı.";
    return jsonResponse(
      result.created ? (result.status === "visible" ? 201 : 202) : 200,
      message,
      { comment: result },
      { setCookie: identity.setCookie },
    );
  });

  const commentsDelete = safeHandler(async (request) => {
    assertSameOriginMutation(request);
    const config = resolveConfig(configSource);
    const identity = getAnonymousIdentity(request, config);
    if (!identity) throw unauthorized();
    const id = validateUuid(new URL(request.url).searchParams.get("id"), "Yorum kimliği");
    await enforceRateLimit(
      request,
      config,
      identity,
      "comment-delete",
      RATE_RULES.commentDelete,
    );
    const deleted = await repository.deleteOwnedComment(config, {
      id,
      actorHash: identity.subject("comment"),
    });
    if (!deleted) {
      throw notFound("Yorum bulunamadı veya bu yorumu silme yetkiniz yok.");
    }
    return jsonResponse(200, "Yorumunuz silindi.", { id });
  });

  return Object.freeze({
    engagement: Object.freeze({ GET: engagementGet }),
    likes: Object.freeze({ PUT: likesPut }),
    listens: Object.freeze({ POST: listensPost }),
    comments: Object.freeze({
      GET: commentsGet,
      POST: commentsPost,
      DELETE: commentsDelete,
    }),
  });
}

export const application = createApplication();
