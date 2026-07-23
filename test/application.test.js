import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "../server/application.js";

const config = Object.freeze({
  databaseUrl: "postgresql://unused.example/test",
  communitySecret: "unit-test-community-secret-is-at-least-32-bytes",
  cookieMaxAge: 31_536_000,
  listenHeartbeatMs: 10_000,
  listenPulseCapMs: 10_000,
  listenTargetMs: 30_000,
  listenSessionTtlSeconds: 1_200,
});

const UUIDS = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174001",
  "323e4567-e89b-42d3-a456-426614174002",
  "423e4567-e89b-42d3-a456-426614174003",
];

function mutation(path, method, body, cookie = null, headers = {}) {
  return new Request(`https://miras.example${path}`, {
    method,
    headers: {
      origin: "https://miras.example",
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || null;
}

function createFakeRepository() {
  const likedActors = new Set();
  const comments = new Map();
  let plays = 0;
  return {
    async getEngagement(_config, actorHash) {
      return {
        plays,
        likes: likedActors.size,
        comments: [...comments.values()].filter((item) => item.status === "visible").length,
        liked: actorHash ? likedActors.has(actorHash) : false,
        tracks: [],
      };
    },
    async setAlbumLike(_config, actorHash, liked) {
      if (liked) likedActors.add(actorHash);
      else likedActors.delete(actorHash);
      return { liked: likedActors.has(actorHash), likes: likedActors.size };
    },
    async createListenSession(_config, input) {
      return { id: input.id, trackSlug: input.trackSlug };
    },
    async pulseListenSession() {
      plays += 1;
      return {
        counted: true,
        credited: true,
        deduplicated: false,
        accumulatedMs: 30_000,
        plays,
        trackPlays: plays,
      };
    },
    async listComments(_config, input) {
      return [...comments.values()]
        .filter((item) => item.status === "visible")
        .map((item) => ({ ...item, owned: item.actorHash === input.viewerActorHash }));
    },
    async createComment(_config, input) {
      const comment = {
        id: input.id,
        trackSlug: input.trackSlug,
        trackLabel: input.trackSlug ? "Feryad · Akustik" : null,
        name: input.displayName || "Misafir",
        body: input.body,
        status: input.status,
        createdAt: "2026-07-23T12:00:00.000Z",
        created: true,
        owned: true,
        actorHash: input.actorHash,
      };
      comments.set(input.id, comment);
      return comment;
    },
    async deleteOwnedComment(_config, input) {
      const comment = comments.get(input.id);
      if (!comment || comment.actorHash !== input.actorHash || comment.status === "deleted") {
        return false;
      }
      comment.status = "deleted";
      return true;
    },
  };
}

function createTestApp() {
  let uuidIndex = 0;
  return createApplication({
    config,
    repository: createFakeRepository(),
    rateLimiter: async () => ({ allowed: true, retryAfter: 0 }),
    randomUUID: () => UUIDS[uuidIndex++ % UUIDS.length],
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });
}

test("album like PUT aynı durumu tekrar gönderince idempotent kalır", async () => {
  const app = createTestApp();
  const first = await app.likes.PUT(mutation("/api/likes", "PUT", { liked: true }));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.likes, 1);
  assert.equal(firstBody.liked, true);
  const cookie = cookieFrom(first);
  assert.ok(cookie);

  const second = await app.likes.PUT(
    mutation("/api/likes", "PUT", { liked: true }, cookie),
  );
  assert.deepEqual(
    { likes: (await second.clone().json()).likes, liked: (await second.json()).liked },
    { likes: 1, liked: true },
  );

  const removed = await app.likes.PUT(
    mutation("/api/likes", "PUT", { liked: false }, cookie),
  );
  assert.deepEqual(
    { likes: (await removed.clone().json()).likes, liked: (await removed.json()).liked },
    { likes: 0, liked: false },
  );
});

test("engagement yanıtı UI sözleşmesindeki counts yapısını korur", async () => {
  const app = createTestApp();
  const response = await app.engagement.GET(
    new Request("https://miras.example/api/engagement"),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.counts, { plays: 0, likes: 0, comments: 0 });
  assert.equal(body.liked, false);
  assert.deepEqual(body.tracks, []);
});

test("listen start token üretir, pulse yalnız aynı anonim cookie ile çalışır", async () => {
  const app = createTestApp();
  const started = await app.listens.POST(mutation("/api/listens", "POST", {
    action: "start",
    trackSlug: "01-feryad-akustik",
  }));
  assert.equal(started.status, 201);
  const startedBody = await started.clone().json();
  assert.equal(startedBody.thresholdMs, 30_000);
  assert.ok(startedBody.token);
  const cookie = cookieFrom(started);

  const withoutCookie = await app.listens.POST(mutation("/api/listens", "POST", {
    action: "pulse",
    token: startedBody.token,
  }));
  assert.equal(withoutCookie.status, 401);

  const pulse = await app.listens.POST(mutation("/api/listens", "POST", {
    action: "pulse",
    token: startedBody.token,
  }, cookie));
  assert.equal(pulse.status, 200);
  assert.deepEqual(
    {
      counted: (await pulse.clone().json()).counted,
      plays: (await pulse.clone().json()).plays,
      accumulatedMs: (await pulse.json()).accumulatedMs,
    },
    { counted: true, plays: 1, accumulatedMs: 30_000 },
  );
});

test("listen start ağ tekrarında aynı idempotency anahtarını oturum kimliği yapar", async () => {
  const sessionIds = [];
  const repository = createFakeRepository();
  const originalCreate = repository.createListenSession;
  repository.createListenSession = async (runtimeConfig, input) => {
    sessionIds.push(input.id);
    return originalCreate(runtimeConfig, input);
  };
  const app = createApplication({
    config,
    repository,
    rateLimiter: async () => ({ allowed: true, retryAfter: 0 }),
    randomUUID: () => UUIDS[0],
  });
  const headers = { "idempotency-key": UUIDS[3] };
  const first = await app.listens.POST(mutation("/api/listens", "POST", {
    action: "start",
    trackSlug: "01-feryad-akustik",
  }, null, headers));
  const cookie = cookieFrom(first);
  const second = await app.listens.POST(mutation("/api/listens", "POST", {
    action: "start",
    trackSlug: "01-feryad-akustik",
  }, cookie, headers));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(sessionIds, [UUIDS[3], UUIDS[3]]);
});

test("temiz yorum yayımlanır, şüpheli yorum pending döner", async () => {
  const app = createTestApp();
  const clean = await app.comments.POST(mutation("/api/comments", "POST", {
    name: "Selin",
    body: "Bu albümün şiirle kurduğu bağ çok güzel.",
  }));
  assert.equal(clean.status, 201);
  const cleanBody = await clean.clone().json();
  assert.equal(cleanBody.comment.status, "visible");
  assert.equal(cleanBody.comment.name, "Selin");
  assert.equal(cleanBody.comment.owned, true);
  const cookie = cookieFrom(clean);

  const suspicious = await app.comments.POST(mutation(
    "/api/comments",
    "POST",
    { body: "Detay için https://spam.example adresine gelin." },
    cookie,
  ));
  assert.equal(suspicious.status, 202);
  assert.equal((await suspicious.json()).comment.status, "pending");
});

test("yorum sadece aynı anonim cookie sahibi tarafından silinir", async () => {
  const app = createTestApp();
  const created = await app.comments.POST(mutation("/api/comments", "POST", {
    body: "Silme sahipliği için örnek yorum.",
  }));
  const payload = await created.clone().json();
  const ownerCookie = cookieFrom(created);

  const foreignStart = await app.likes.PUT(mutation("/api/likes", "PUT", { liked: true }));
  const foreignCookie = cookieFrom(foreignStart);
  const denied = await app.comments.DELETE(mutation(
    `/api/comments?id=${payload.comment.id}`,
    "DELETE",
    undefined,
    foreignCookie,
  ));
  assert.equal(denied.status, 404);

  const deleted = await app.comments.DELETE(mutation(
    `/api/comments?id=${payload.comment.id}`,
    "DELETE",
    undefined,
    ownerCookie,
  ));
  assert.equal(deleted.status, 200);
});

test("same-origin olmayan mutasyon veri katmanına ulaşmadan reddedilir", async () => {
  const app = createTestApp();
  const request = mutation("/api/likes", "PUT", { liked: true });
  const headers = new Headers(request.headers);
  headers.set("origin", "https://evil.example");
  const response = await app.likes.PUT(new Request(request, { headers }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "KAYNAK_DOGRULANAMADI");
});

test("Postgres rate-limit sonucu 429 ve Retry-After üretir", async () => {
  const app = createApplication({
    config,
    repository: createFakeRepository(),
    rateLimiter: async () => ({ allowed: false, retryAfter: 17 }),
    randomUUID: () => UUIDS[0],
  });
  const response = await app.likes.PUT(mutation("/api/likes", "PUT", { liked: true }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
});
