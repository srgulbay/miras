import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAnonymousIdentity,
  issueAnonymousCookie,
  verifyAnonymousCookie,
} from "../server/identity.js";
import {
  issueListenToken,
  verifyListenToken,
} from "../server/listen-token.js";

const config = Object.freeze({
  communitySecret: "unit-test-community-secret-is-at-least-32-bytes",
  cookieMaxAge: 31_536_000,
});

function cookieValue(header) {
  return header.split(";")[0].split("=").slice(1).join("=");
}

test("HTTPS anonim cookie güvenli __Host nitelikleriyle imzalanır", () => {
  const request = new Request("https://miras.example/api/likes");
  const issued = issueAnonymousCookie(request, config);

  assert.match(issued.header, /^__Host-miras_anon=/);
  assert.match(issued.header, /; HttpOnly/);
  assert.match(issued.header, /; Secure/);
  assert.match(issued.header, /; SameSite=Strict/);
  assert.equal(verifyAnonymousCookie(config, issued.value), issued.id);
});

test("localhost HTTP cookie Secure olmadan çalışır", () => {
  const request = new Request("http://localhost:4173/api/likes");
  const issued = issueAnonymousCookie(request, config);

  assert.match(issued.header, /^miras_anon=/);
  assert.doesNotMatch(issued.header, /; Secure/);
  assert.equal(verifyAnonymousCookie(config, issued.value), issued.id);
});

test("cookie tahrifi reddedilir ve amaç bazlı actor hashleri ayrılır", () => {
  const base = new Request("https://miras.example/api/likes");
  const issued = issueAnonymousCookie(base, config);
  const tampered = `${issued.value.slice(0, -1)}${issued.value.endsWith("A") ? "B" : "A"}`;
  assert.equal(verifyAnonymousCookie(config, tampered), null);

  const request = new Request(base.url, {
    headers: { cookie: `__Host-miras_anon=${cookieValue(issued.header)}` },
  });
  const identity = getAnonymousIdentity(request, config);
  assert.ok(identity);
  assert.equal(identity.subject("like").length, 64);
  assert.notEqual(identity.subject("like"), identity.subject("comment"));
  assert.equal(identity.setCookie, null);
});

test("dinleme tokenı imzalıdır ve tahrifte reddedilir", () => {
  const session = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    trackSlug: "01-feryad-akustik",
  };
  const token = issueListenToken(config, session);
  assert.deepEqual(verifyListenToken(config, token), session);

  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => verifyListenToken(config, tampered), /geçerli değil/i);
});
