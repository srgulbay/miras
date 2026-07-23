import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSameOriginMutation,
  jsonResponse,
  readJson,
} from "../server/http.js";
import { prepareComment } from "../server/moderation.js";
import {
  decodeCursor,
  encodeCursor,
} from "../server/validation.js";

test("mutasyon yalnız tam request origin eşleşmesinde kabul edilir", () => {
  const accepted = new Request("https://miras.example/api/likes", {
    method: "PUT",
    headers: {
      origin: "https://miras.example",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.doesNotThrow(() => assertSameOriginMutation(accepted));

  for (const origin of [
    "https://evil.example",
    "http://miras.example",
    "https://miras.example.evil.test",
    "null",
  ]) {
    const rejected = new Request("https://miras.example/api/likes", {
      method: "PUT",
      headers: { origin },
    });
    assert.throws(() => assertSameOriginMutation(rejected));
  }

  assert.throws(() =>
    assertSameOriginMutation(new Request("https://miras.example/api/likes", {
      method: "PUT",
    })));
});

test("JSON okuyucu içerik türü, biçim ve boyut sınırını uygular", async () => {
  await assert.rejects(
    readJson(new Request("https://miras.example/api/likes", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "text/plain" },
    })),
  );
  await assert.rejects(
    readJson(new Request("https://miras.example/api/likes", {
      method: "PUT",
      body: "{",
      headers: { "content-type": "application/json" },
    })),
  );
  await assert.rejects(
    readJson(new Request("https://miras.example/api/likes", {
      method: "PUT",
      body: JSON.stringify({ body: "x".repeat(9_000) }),
      headers: { "content-type": "application/json" },
    })),
  );
});

test("temiz yorum görünür, şüpheli yorum pending olur", () => {
  const clean = prepareComment({
    displayName: "Deniz",
    body: "Albümün şiirle kurduğu bağ gerçekten çok güzel.",
  });
  assert.equal(clean.status, "visible");
  assert.equal(clean.moderationReason, null);

  const suspicious = prepareComment({
    displayName: "Deniz",
    body: "Devamı için https://spam.example adresine gelin.",
  });
  assert.equal(suspicious.status, "pending");
  assert.equal(suspicious.moderationReason, "iletisim_veya_baglanti");
});

test("yorum normalizasyonu kontrol karakterlerini ve sınırları reddeder", () => {
  assert.throws(() => prepareComment({ body: "iyi\u202Eyorum" }));
  assert.throws(() => prepareComment({ body: "  " }));
  assert.throws(() => prepareComment({ body: "a".repeat(801) }));

  const normalized = prepareComment({
    body: "  İlk satır  \r\n\r\n\r\n  İkinci satır  ",
  });
  assert.equal(normalized.body, "İlk satır\n\nİkinci satır");
});

test("cursor kararlı biçimde round-trip yapar", () => {
  const comment = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-07-23T12:34:56.123456Z",
  };
  assert.deepEqual(decodeCursor(encodeCursor(comment)), comment);
  assert.throws(() => decodeCursor("bozuk"));
});

test("bütün API yanıtları no-store ve Türkçe mesajlıdır", async () => {
  const response = jsonResponse(200, "İşlem tamamlandı.", { value: 1 });
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    ok: true,
    message: "İşlem tamamlandı.",
    value: 1,
  });
});
