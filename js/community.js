/* ═══════════════════════════════════════════════════════════════
   MİRAS · dinlenme, beğeni ve yorum topluluğu
   Sunucu verisi olmadan sayaç veya yorum taklidi yapılmaz.
   ═══════════════════════════════════════════════════════════════ */
(() => {
"use strict";

const $id = id => document.getElementById(id);
const els = {
  engagement:   $id("engagement"),
  playCount:    $id("play-count"),
  likeButton:   $id("like-button"),
  likeCount:    $id("like-count"),
  likeSummaryCount: $id("like-summary-count"),
  commentCount: $id("comment-count"),
  form:         $id("comments-form"),
  name:         $id("comment-name"),
  track:        $id("comment-track"),
  body:         $id("comment-body"),
  website:      $id("comment-website"),
  status:       $id("comments-status"),
  list:         $id("comments-list"),
  more:         $id("comments-more"),
};

if (Object.values(els).some(el => !el)) return;

const audio = $id("audio");
const numberFormat = new Intl.NumberFormat("tr-TR");
const dateFormat = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const PAGE_SIZE = 8;
const MIN_LISTEN_MS = 30_000;
const PULSE_INTERVAL_MS = 10_000;
const MAX_LISTEN_THRESHOLD_MS = 10 * 60_000;
const API_TIMEOUT_MS = 12_000;
const staticHost = location.protocol === "file:" || /\.github\.io$/i.test(location.hostname);
const moreDefaultText = els.more.textContent.trim() || "Daha fazla yorum";
const submitButton = els.form.querySelector('[type="submit"]');
const trackLabels = new Map(
  typeof TRACKS !== "undefined" && Array.isArray(TRACKS)
    ? TRACKS.map(track => [
        track.slug,
        track.title + (track.variant ? ` · ${track.variant}` : ""),
      ])
    : []
);
const trackUi = new Map();

document.querySelectorAll(".track[data-track-slug]").forEach(row => {
  const trackSlug = row.dataset.trackSlug;
  const playsWrap = row.querySelector("[data-track-plays-wrap]");
  const playsLabel = row.querySelector("[data-track-plays-label]");
  const playCount = row.querySelector("[data-track-plays]");
  const likeButton = row.querySelector("[data-track-like]");
  const likeCount = row.querySelector("[data-track-likes]");
  if (
    trackSlug &&
    playsWrap &&
    playsLabel &&
    playCount &&
    likeButton &&
    likeCount
  ) {
    trackUi.set(trackSlug, {
      playsWrap,
      playsLabel,
      playCount,
      likeButton,
      likeCount,
    });
  }
});

const state = {
  apiAvailable: null,
  unavailablePermanent: staticHost,
  liked: false,
  likePending: false,
  counts: { plays: null, likes: null, comments: null },
  trackStats: new Map(),
  trackLikePending: new Set(),
  commentsLoading: false,
  commentsLoaded: false,
  nextCursor: null,
  commentIds: new Set(),
  commentSubmitting: false,
  pendingCommentRequest: null,
  formStartedAt: Date.now(),
  bootstrapPromise: null,
  bootstrapRetryTimer: 0,
};

const engagementStatus = document.createElement("span");
engagementStatus.className = "sr-only";
engagementStatus.setAttribute("role", "status");
engagementStatus.setAttribute("aria-live", "polite");
engagementStatus.setAttribute("aria-atomic", "true");
els.engagement.appendChild(engagementStatus);

els.status.setAttribute("role", "status");
els.status.setAttribute("aria-live", "polite");
els.status.setAttribute("aria-atomic", "true");
els.list.setAttribute("aria-busy", "true");
els.engagement.setAttribute("aria-busy", "true");
els.form.setAttribute("aria-busy", "false");
els.likeButton.type = "button";
els.likeButton.setAttribute("aria-pressed", "false");
els.more.type = "button";
els.more.hidden = true;

/* Bal küpü: gerçek kullanıcıların doldurmaması ve erişilebilirlik ağacına
   girmemesi gerekir; değer yine de sunucuya bot kontrolü için gönderilir. */
els.website.tabIndex = -1;
els.website.autocomplete = "off";
els.website.setAttribute("aria-hidden", "true");

function announce(message) {
  engagementStatus.textContent = "";
  requestAnimationFrame(() => { engagementStatus.textContent = message; });
}

function setCommentsStatus(message, kind = "") {
  els.status.textContent = message;
  if (kind) els.status.dataset.state = kind;
  else delete els.status.dataset.state;
}

function isCount(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    (typeof value === "string" && !/^\d+$/.test(value))
  ) return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0;
}

function normalizedCount(value) {
  return isCount(value) ? Number(value) : null;
}

function formattedCount(value) {
  return isCount(value) ? numberFormat.format(Number(value)) : "—";
}

function updateCounts(partial = {}) {
  for (const key of ["plays", "likes", "comments"]) {
    if (Object.prototype.hasOwnProperty.call(partial, key) && isCount(partial[key])) {
      state.counts[key] = Number(partial[key]);
    }
  }

  els.playCount.textContent = formattedCount(state.counts.plays);
  els.likeCount.textContent = formattedCount(state.counts.likes);
  els.likeSummaryCount.textContent = formattedCount(state.counts.likes);
  els.commentCount.textContent = formattedCount(state.counts.comments);

  els.playCount.title = isCount(state.counts.plays)
    ? `${numberFormat.format(state.counts.plays)} dinlenme`
    : "Dinlenme bilgisi kullanılamıyor";
  els.likeSummaryCount.title = isCount(state.counts.likes)
    ? `${numberFormat.format(state.counts.likes)} beğeni`
    : "Beğeni bilgisi kullanılamıyor";
  els.commentCount.title = isCount(state.counts.comments)
    ? `${numberFormat.format(state.counts.comments)} yorum`
    : "Yorum bilgisi kullanılamıyor";

  if (isCount(state.counts.plays)) {
    els.playCount.setAttribute("aria-label", `${numberFormat.format(state.counts.plays)} dinlenme`);
  } else {
    els.playCount.removeAttribute("aria-label");
  }
  if (isCount(state.counts.comments)) {
    els.commentCount.setAttribute("aria-label", `${numberFormat.format(state.counts.comments)} yorum`);
  } else {
    els.commentCount.removeAttribute("aria-label");
  }

  renderLikeState();

  if (["plays", "likes", "comments"].every(key => isCount(state.counts[key]))) {
    els.engagement.setAttribute(
      "aria-label",
      `Albüm etkileşimi: ${numberFormat.format(state.counts.plays)} dinlenme, ` +
      `${numberFormat.format(state.counts.likes)} beğeni, ` +
      `${numberFormat.format(state.counts.comments)} yorum`
    );
  } else {
    els.engagement.setAttribute("aria-label", "Albüm etkileşim bilgileri");
  }
}

function renderLikeState() {
  const countText = isCount(state.counts.likes)
    ? `${numberFormat.format(state.counts.likes)} beğeni`
    : "beğeni sayısı kullanılamıyor";
  els.likeButton.setAttribute("aria-pressed", String(state.liked));
  els.likeButton.setAttribute(
    "aria-label",
    state.apiAvailable === false
      ? "Beğeni şu anda kullanılamıyor"
      : `${state.liked ? "Beğeniyi kaldır" : "Albümü beğen"}, ${countText}`
  );
  els.likeButton.title = state.apiAvailable === false
    ? "Beğeni şu anda kullanılamıyor"
    : (state.liked ? "Beğeniyi kaldır" : "Albümü beğen");
}

function normalizeTrackEngagement(raw) {
  if (
    !raw ||
    typeof raw.trackSlug !== "string" ||
    !trackUi.has(raw.trackSlug) ||
    !isCount(raw.plays) ||
    !isCount(raw.likes) ||
    !isCount(raw.comments)
  ) {
    return null;
  }
  return {
    trackSlug: raw.trackSlug,
    plays: Number(raw.plays),
    likes: Number(raw.likes),
    comments: Number(raw.comments),
    liked: raw.liked === true,
  };
}

function renderTrackEngagement(trackSlug) {
  const ui = trackUi.get(trackSlug);
  if (!ui) return;
  const stats = state.trackStats.get(trackSlug);
  const label = trackLabels.get(trackSlug) || "Parça";
  const playsText = stats ? formattedCount(stats.plays) : "—";
  const likesText = stats ? formattedCount(stats.likes) : "—";
  const available = state.apiAvailable === true && Boolean(stats);
  const pending = state.trackLikePending.has(trackSlug);
  const unavailable = state.apiAvailable === false;

  ui.playCount.textContent = playsText;
  ui.likeCount.textContent = likesText;
  ui.playsLabel.textContent = stats
    ? "Dinlenme:"
    : unavailable
      ? "Dinlenme sayısı şu anda kullanılamıyor:"
      : "Dinlenme sayısı yükleniyor:";
  ui.playsWrap.title = stats
    ? `${numberFormat.format(stats.plays)} dinlenme`
    : unavailable
      ? "Dinlenme sayısı şu anda kullanılamıyor"
      : "Dinlenme sayısı yükleniyor";
  ui.likeButton.setAttribute("aria-pressed", String(stats?.liked === true));
  ui.likeButton.setAttribute(
    "aria-label",
    state.apiAvailable === false
      ? `${label} beğenisi şu anda kullanılamıyor`
      : stats
        ? `${stats.liked ? "Beğeniyi kaldır" : "Parçayı beğen"}: ${label}, ${likesText} beğeni`
        : `${label} beğenisi yükleniyor`
  );
  ui.likeButton.title = unavailable
    ? `${label} beğenisi şu anda kullanılamıyor`
    : stats?.liked
      ? `${label} beğenisini kaldır`
      : `${label} parçasını beğen`;
  ui.likeButton.disabled = !available || pending;
  if (pending) ui.likeButton.setAttribute("aria-busy", "true");
  else ui.likeButton.removeAttribute("aria-busy");
}

function renderAllTrackEngagement() {
  for (const trackSlug of trackUi.keys()) renderTrackEngagement(trackSlug);
}

function setTrackEngagement(rows) {
  if (!Array.isArray(rows)) return false;
  const next = new Map();
  for (const raw of rows) {
    const normalized = normalizeTrackEngagement(raw);
    if (normalized) next.set(normalized.trackSlug, normalized);
  }
  if (next.size !== trackUi.size) return false;
  state.trackStats = next;
  renderAllTrackEngagement();
  return true;
}

function setFormAvailable(available) {
  for (const control of els.form.elements) control.disabled = !available;
  els.form.setAttribute("aria-disabled", String(!available));
}

function setUnavailable(message, permanent = false) {
  state.apiAvailable = false;
  state.unavailablePermanent ||= permanent;
  if (currentListen) stopSegment(currentListen);
  els.engagement.dataset.state = "unavailable";
  els.engagement.setAttribute("aria-busy", "false");
  els.list.setAttribute("aria-busy", "false");
  els.likeButton.disabled = true;
  els.likeButton.removeAttribute("aria-busy");
  els.more.hidden = true;
  els.more.disabled = true;
  setFormAvailable(false);
  updateCounts();
  renderAllTrackEngagement();
  setCommentsStatus(message, "unavailable");
  announce(message);
}

function setAvailable() {
  state.apiAvailable = true;
  state.unavailablePermanent = false;
  els.engagement.dataset.state = "ready";
  els.engagement.setAttribute("aria-busy", "false");
  els.likeButton.disabled = false;
  els.more.disabled = false;
  setFormAvailable(true);
  renderLikeState();
  renderAllTrackEngagement();
}

function requestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, token => {
    const value = Math.floor(Math.random() * 16);
    return (token === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

class ApiError extends Error {
  constructor(message, { status = 0, data = null, unavailable = false, retryable = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.unavailable = unavailable;
    this.retryable = retryable;
  }
}

async function api(path, {
  method = "GET",
  body,
  headers = {},
  keepalive = false,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const hasBody = body !== undefined;

  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      keepalive,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });

    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (response.status !== 204 && contentType.includes("application/json")) {
      try { data = await response.json(); } catch (_) {}
    }

    if (!response.ok) {
      throw new ApiError("API isteği başarısız oldu.", {
        status: response.status,
        data,
        unavailable: response.status === 404,
        retryable: response.status >= 500 || response.status === 408,
      });
    }

    if (response.status !== 204 && !contentType.includes("application/json")) {
      throw new ApiError("API JSON yerine geçersiz bir yanıt döndürdü.", {
        status: response.status,
        unavailable: true,
      });
    }

    return data || {};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const timedOut = error?.name === "AbortError";
    throw new ApiError(timedOut ? "API isteği zaman aşımına uğradı." : "Ağ bağlantısı kurulamadı.", {
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(task, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt === attempts - 1) throw error;
      await wait(350 * (2 ** attempt));
    }
  }
  throw lastError;
}

function serverMessage(error, fallback) {
  const message = error?.data?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 300)
    : fallback;
}

/* ── Beğeni ─────────────────────────────────────────────────── */
els.likeButton.addEventListener("click", async () => {
  if (state.apiAvailable !== true || state.likePending || !isCount(state.counts.likes)) return;

  const previousLiked = state.liked;
  const previousCount = state.counts.likes;
  const desiredLiked = !previousLiked;
  state.likePending = true;
  state.liked = desiredLiked;
  state.counts.likes = Math.max(0, previousCount + (desiredLiked ? 1 : -1));
  els.likeButton.disabled = true;
  els.likeButton.setAttribute("aria-busy", "true");
  updateCounts();

  try {
    const result = await api("/api/likes", {
      method: "PUT",
      body: { liked: desiredLiked },
      headers: { "Idempotency-Key": requestId("like") },
    });
    state.liked = typeof result.liked === "boolean" ? result.liked : desiredLiked;
    const serverLikes = normalizedCount(result.likes ?? result.counts?.likes);
    if (serverLikes !== null) state.counts.likes = serverLikes;
    updateCounts();
    announce(state.liked ? "Albümü beğendiniz." : "Beğeniniz kaldırıldı.");
  } catch (error) {
    state.liked = previousLiked;
    state.counts.likes = previousCount;
    updateCounts();
    announce(serverMessage(error, "Beğeni kaydedilemedi. Lütfen yeniden deneyin."));
  } finally {
    state.likePending = false;
    els.likeButton.disabled = state.apiAvailable !== true;
    els.likeButton.removeAttribute("aria-busy");
    renderLikeState();
  }
});

async function toggleTrackLike(trackSlug) {
  const previous = state.trackStats.get(trackSlug);
  if (
    state.apiAvailable !== true ||
    !previous ||
    state.trackLikePending.has(trackSlug)
  ) return;

  const desiredLiked = !previous.liked;
  const optimistic = {
    ...previous,
    liked: desiredLiked,
    likes: Math.max(0, previous.likes + (desiredLiked ? 1 : -1)),
  };
  state.trackLikePending.add(trackSlug);
  state.trackStats.set(trackSlug, optimistic);
  renderTrackEngagement(trackSlug);

  try {
    const result = await api("/api/likes", {
      method: "PUT",
      body: { trackSlug, liked: desiredLiked },
      headers: { "Idempotency-Key": requestId("track-like") },
    });
    if (
      result.trackSlug !== trackSlug ||
      typeof result.liked !== "boolean" ||
      !isCount(result.likes)
    ) {
      throw new ApiError("Parça beğeni yanıtı geçersiz.");
    }
    const current = state.trackStats.get(trackSlug) || optimistic;
    state.trackStats.set(trackSlug, {
      ...current,
      liked: result.liked,
      likes: Number(result.likes),
    });
    const label = trackLabels.get(trackSlug) || "Parça";
    announce(
      result.liked
        ? `${label} parçasını beğendiniz.`
        : `${label} beğeniniz kaldırıldı.`
    );
  } catch (error) {
    const current = state.trackStats.get(trackSlug) || previous;
    state.trackStats.set(trackSlug, {
      ...current,
      liked: previous.liked,
      likes: previous.likes,
    });
    announce(serverMessage(error, "Parça beğenisi kaydedilemedi. Lütfen yeniden deneyin."));
  } finally {
    state.trackLikePending.delete(trackSlug);
    renderTrackEngagement(trackSlug);
  }
}

for (const [trackSlug, ui] of trackUi) {
  ui.likeButton.addEventListener("click", () => toggleTrackLike(trackSlug));
}

/* ── Yorumlar ───────────────────────────────────────────────── */
function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function commentRecord(raw, statusOverride = "") {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.id, 160);
  const body = cleanText(raw.body, 5_000);
  if (!id || !body) return null;
  return {
    id,
    name: cleanText(raw.name, 120) || "Dinleyici",
    body,
    trackSlug: cleanText(raw.trackSlug, 120),
    trackLabel: cleanText(raw.trackLabel, 220),
    createdAt: cleanText(raw.createdAt, 80),
    owned: raw.owned === true,
    status: cleanText(statusOverride || raw.status, 40).toLowerCase(),
  };
}

function createCommentElement(raw, statusOverride = "") {
  const comment = commentRecord(raw, statusOverride);
  if (!comment || state.commentIds.has(comment.id)) return null;
  state.commentIds.add(comment.id);

  const item = document.createElement(els.list.matches("ol, ul") ? "li" : "article");
  item.className = "comment";
  item.dataset.commentId = comment.id;
  if (["pending", "review", "moderation"].includes(comment.status)) {
    item.classList.add("comment--pending");
  }

  const head = document.createElement("div");
  head.className = "comment__head";

  const author = document.createElement("strong");
  author.className = "comment__author";
  author.textContent = comment.name;
  head.appendChild(author);

  if (comment.trackLabel) {
    const track = document.createElement("span");
    track.className = "comment__track";
    track.textContent = comment.trackLabel;
    if (comment.trackSlug) track.dataset.trackSlug = comment.trackSlug;
    head.appendChild(track);
  }

  if (comment.createdAt) {
    const date = new Date(comment.createdAt);
    if (!Number.isNaN(date.getTime())) {
      const time = document.createElement("time");
      time.className = "comment__time";
      time.dateTime = date.toISOString();
      time.textContent = dateFormat.format(date);
      time.title = date.toLocaleString("tr-TR");
      head.appendChild(time);
    }
  }

  if (item.classList.contains("comment--pending")) {
    const pending = document.createElement("span");
    pending.className = "comment__pending";
    pending.textContent = "İncelemede";
    head.appendChild(pending);
  }

  let remove = null;
  if (comment.owned) {
    remove = document.createElement("button");
    remove.type = "button";
    remove.className = "comment__delete";
    remove.textContent = "Sil";
    remove.setAttribute("aria-label", "Yorumunuzu sil");
    remove.addEventListener("click", () => deleteComment(item, comment, remove));
  }

  const body = document.createElement("p");
  body.className = "comment__body";
  body.textContent = comment.body;

  item.append(head, body);
  if (remove) item.appendChild(remove);
  return item;
}

function setMoreButton({ hidden, retry = false } = {}) {
  els.more.hidden = Boolean(hidden);
  els.more.disabled = state.commentsLoading || state.apiAvailable !== true;
  els.more.textContent = retry ? "Yeniden dene" : moreDefaultText;
  els.more.dataset.mode = retry ? "retry" : "more";
  els.more.setAttribute(
    "aria-label",
    retry ? "Yorumları yeniden yükle" : "Daha fazla yorum yükle"
  );
}

async function loadComments({ reset = false } = {}) {
  if (state.apiAvailable !== true || state.commentsLoading) return false;
  state.commentsLoading = true;
  els.list.setAttribute("aria-busy", "true");
  els.more.setAttribute("aria-busy", "true");
  els.more.disabled = true;
  setCommentsStatus(reset ? "Yorumlar yükleniyor…" : "Daha fazla yorum yükleniyor…");

  if (reset) {
    state.nextCursor = null;
    state.commentIds.clear();
    els.list.replaceChildren();
  }

  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (!reset && state.nextCursor) params.set("cursor", state.nextCursor);

  try {
    const result = await api(`/api/comments?${params}`);
    if (!Array.isArray(result.comments)) {
      throw new ApiError("Yorum yanıtı geçersiz.");
    }

    let added = 0;
    const fragment = document.createDocumentFragment();
    for (const raw of result.comments) {
      const item = createCommentElement(raw);
      if (item) {
        fragment.appendChild(item);
        added++;
      }
    }
    els.list.appendChild(fragment);

    state.nextCursor = typeof result.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : null;
    state.commentsLoaded = true;
    if (isCount(result.count)) updateCounts({ comments: result.count });

    if (reset && added === 0) {
      setCommentsStatus("Henüz yorum yok. İlk yorumu siz bırakın.");
    } else {
      setCommentsStatus("");
    }
    setMoreButton({ hidden: !state.nextCursor });

    if (!state.nextCursor && document.activeElement === els.more) {
      els.status.tabIndex = -1;
      els.status.focus({ preventScroll: true });
    }
    return true;
  } catch (error) {
    setCommentsStatus(
      serverMessage(
        error,
        reset
          ? "Yorumlar yüklenemedi. Lütfen yeniden deneyin."
          : "Daha fazla yorum yüklenemedi. Lütfen yeniden deneyin."
      ),
      "error"
    );
    setMoreButton({ hidden: false, retry: true });
    return false;
  } finally {
    state.commentsLoading = false;
    els.list.setAttribute("aria-busy", "false");
    els.more.removeAttribute("aria-busy");
    els.more.disabled = state.apiAvailable !== true;
  }
}

els.more.addEventListener("click", () => {
  loadComments({ reset: els.more.dataset.mode === "retry" && !state.commentsLoaded });
});

function commentSignature(payload) {
  return JSON.stringify([
    payload.name,
    payload.body,
    payload.trackSlug,
    payload.website,
    payload.formStartedAt,
  ]);
}

function commentRequestFor(payload) {
  const signature = commentSignature(payload);
  if (state.pendingCommentRequest?.signature === signature) {
    return state.pendingCommentRequest.id;
  }
  const id = requestId("comment");
  state.pendingCommentRequest = { id, signature };
  return id;
}

for (const field of [els.name, els.body]) {
  field.addEventListener("input", () => field.removeAttribute("aria-invalid"));
}

els.form.addEventListener("submit", async event => {
  event.preventDefault();
  if (state.apiAvailable !== true || state.commentSubmitting) return;

  const name = cleanText(els.name.value.replace(/\s+/g, " "), 120);
  const body = cleanText(els.body.value, 5_000);
  const rawTrack = cleanText(els.track.value, 120);
  const trackSlug = /^[a-z0-9-]{1,120}$/i.test(rawTrack) ? rawTrack : null;

  if (!name) {
    els.name.setAttribute("aria-invalid", "true");
    setCommentsStatus("Lütfen adınızı yazın.", "error");
    els.name.focus();
    return;
  }
  if (!body) {
    els.body.setAttribute("aria-invalid", "true");
    setCommentsStatus("Lütfen yorumunuzu yazın.", "error");
    els.body.focus();
    return;
  }
  if (!els.form.checkValidity()) {
    els.form.reportValidity();
    return;
  }

  const basePayload = {
    name,
    body,
    trackSlug,
    website: cleanText(els.website.value, 300),
    formStartedAt: state.formStartedAt,
  };
  const clientRequestId = commentRequestFor(basePayload);
  const payload = { ...basePayload, clientRequestId };
  const restoreSubmitFocus = document.activeElement === submitButton;

  state.commentSubmitting = true;
  els.form.setAttribute("aria-busy", "true");
  if (submitButton) submitButton.disabled = true;
  setCommentsStatus("Yorumunuz gönderiliyor…");

  try {
    const result = await api("/api/comments", {
      method: "POST",
      body: payload,
      headers: { "Idempotency-Key": clientRequestId },
    });
    const responseStatus = cleanText(result.status, 40).toLowerCase();
    const item = result.comment
      ? createCommentElement(result.comment, responseStatus)
      : null;
    if (item) els.list.prepend(item);

    if (isCount(result.count)) {
      updateCounts({ comments: result.count });
    } else if (item && !item.classList.contains("comment--pending") && isCount(state.counts.comments)) {
      updateCounts({ comments: state.counts.comments + 1 });
    }

    els.body.value = "";
    els.track.value = "";
    els.website.value = "";
    state.formStartedAt = Date.now();
    state.pendingCommentRequest = null;
    const fallback = item?.classList.contains("comment--pending")
      ? "Yorumunuz incelemeye alındı."
      : "Yorumunuz yayınlandı.";
    setCommentsStatus(
      typeof result.message === "string" && result.message.trim()
        ? result.message.trim().slice(0, 300)
        : fallback,
      item?.classList.contains("comment--pending") ? "pending" : "success"
    );
  } catch (error) {
    setCommentsStatus(
      serverMessage(error, "Yorum gönderilemedi. Metniniz korundu; lütfen yeniden deneyin."),
      "error"
    );
  } finally {
    state.commentSubmitting = false;
    els.form.setAttribute("aria-busy", "false");
    if (submitButton) {
      submitButton.disabled = state.apiAvailable !== true;
      if (restoreSubmitFocus && state.apiAvailable === true) {
        submitButton.focus({ preventScroll: true });
      }
    }
  }
});

async function deleteComment(item, comment, button) {
  if (state.apiAvailable !== true || !comment.owned) return;
  if (!window.confirm("Yorumunuzu silmek istediğinize emin misiniz?")) return;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  item.setAttribute("aria-busy", "true");
  setCommentsStatus("Yorumunuz siliniyor…");

  try {
    const params = new URLSearchParams({ id: comment.id });
    const result = await api(`/api/comments?${params}`, { method: "DELETE" });
    const wasPublished = !item.classList.contains("comment--pending");
    state.commentIds.delete(comment.id);
    item.remove();
    if (isCount(result.count)) {
      updateCounts({ comments: result.count });
    } else if (wasPublished && isCount(state.counts.comments)) {
      updateCounts({ comments: Math.max(0, state.counts.comments - 1) });
    }
    setCommentsStatus("Yorumunuz silindi.", "success");
    els.status.tabIndex = -1;
    els.status.focus({ preventScroll: true });
  } catch (error) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    item.setAttribute("aria-busy", "false");
    setCommentsStatus(
      serverMessage(error, "Yorum silinemedi. Lütfen yeniden deneyin."),
      "error"
    );
  }
}

function populateTrackSelect() {
  if (!(els.track instanceof HTMLSelectElement)) return;
  if ([...els.track.options].some(option => option.value)) return;
  if (typeof TRACKS === "undefined" || !Array.isArray(TRACKS)) return;

  TRACKS.forEach((track, index) => {
    if (!track?.slug || !track?.title) return;
    const option = document.createElement("option");
    option.value = track.slug;
    option.textContent =
      `${String(index + 1).padStart(2, "0")}. ${track.title}` +
      (track.variant ? ` (${track.variant})` : "");
    els.track.appendChild(option);
  });
}

/* ── Nitelikli dinlenme ───────────────────────────────────────
   Sunucu yaklaşık her 10 saniyelik gerçek oynatma için bir pulse alır ve
   toplam 30 saniyeyi atomik olarak krediler. İstemci kredi talep etmez. */
let currentListen = null;
let listenTickTimer = 0;
let audioActuallyPlaying = false;
let resumeAfterSeek = false;

function currentTrackSlug() {
  const slug = cleanText(audio?.dataset.trackSlug, 120);
  return /^[a-z0-9-]{1,120}$/i.test(slug) ? slug : "";
}

function newListenSession(trackSlug) {
  return {
    trackSlug,
    token: "",
    thresholdMs: MIN_LISTEN_MS,
    serverAccumulatedMs: 0,
    activeSincePulseMs: 0,
    segmentStartedAt: null,
    active: true,
    completed: false,
    pulseInFlight: false,
    pulseAttempts: 0,
    retryTimer: 0,
    startPromise: null,
    startKey: requestId("listen-start"),
  };
}

function stopListenTick() {
  if (listenTickTimer) {
    clearInterval(listenTickTimer);
    listenTickTimer = 0;
  }
}

function captureActiveTime(session, continueSegment = false) {
  if (!session || session.segmentStartedAt === null) return;
  session.activeSincePulseMs += Math.max(0, performance.now() - session.segmentStartedAt);
  session.segmentStartedAt = continueSegment ? performance.now() : null;
}

function canAccumulate() {
  return Boolean(
    audio &&
    audioActuallyPlaying &&
    !audio.paused &&
    !audio.ended &&
    !audio.seeking &&
    audio.readyState >= 3
  );
}

function isPlayingSession(session) {
  return Boolean(
    session &&
    session === currentListen &&
    session.active &&
    !session.completed &&
    currentTrackSlug() === session.trackSlug &&
    canAccumulate()
  );
}

function stopSegment(session = currentListen) {
  if (!session) return;
  captureActiveTime(session, false);
  if (session === currentListen) stopListenTick();
  if (session.retryTimer) {
    clearTimeout(session.retryTimer);
    session.retryTimer = 0;
  }
}

function startSegment() {
  if (!audio || state.apiAvailable === false || !canAccumulate()) return;
  const slug = currentTrackSlug();
  if (!slug) return;

  if (!currentListen || currentListen.trackSlug !== slug || !currentListen.active) {
    finishCurrentListen();
    currentListen = newListenSession(slug);
  }
  if (currentListen.completed) return;

  ensureListenToken(currentListen).catch(() => {});
  if (currentListen.segmentStartedAt === null) {
    currentListen.segmentStartedAt = performance.now();
  }
  maybePulse(currentListen);

  if (!listenTickTimer) {
    listenTickTimer = setInterval(() => {
      if (!isPlayingSession(currentListen)) {
        stopSegment(currentListen);
        return;
      }
      maybePulse(currentListen);
    }, 1_000);
  }
}

function finishCurrentListen() {
  const session = currentListen;
  if (!session) return;
  stopSegment(session);
  session.active = false;
  currentListen = null;
}

async function ensureListenToken(session) {
  if (session.token) return session.token;
  if (session.startPromise) return session.startPromise;
  if (state.apiAvailable === false) throw new ApiError("Dinlenme API kullanılamıyor.");

  session.startPromise = withRetry(
    () => api("/api/listens", {
      method: "POST",
      body: { action: "start", trackSlug: session.trackSlug },
      headers: { "Idempotency-Key": session.startKey },
    }),
    2
  ).then(result => {
    const token = cleanText(result.token, 512);
    if (!token) throw new ApiError("Dinlenme tokenı alınamadı.");
    const serverThreshold = Number(result.thresholdMs);
    session.token = token;
    session.thresholdMs = Number.isFinite(serverThreshold)
      ? Math.min(MAX_LISTEN_THRESHOLD_MS, Math.max(MIN_LISTEN_MS, Math.round(serverThreshold)))
      : MIN_LISTEN_MS;
    maybePulse(session);
    return token;
  }).finally(() => {
    session.startPromise = null;
  });

  return session.startPromise;
}

function schedulePulseRetry(session) {
  if (
    !isPlayingSession(session) ||
    session.pulseInFlight ||
    session.retryTimer ||
    session.activeSincePulseMs < PULSE_INTERVAL_MS
  ) return;

  const exponent = Math.min(4, Math.max(0, session.pulseAttempts - 1));
  const delay = Math.min(15_000, 1_500 * (2 ** exponent));
  session.retryTimer = setTimeout(() => {
    session.retryTimer = 0;
    if (isPlayingSession(session)) sendPulse(session);
  }, delay);
}

function maybePulse(session) {
  if (!isPlayingSession(session) || session.pulseInFlight) return;
  captureActiveTime(session, true);
  if (session.activeSincePulseMs < PULSE_INTERVAL_MS) return;
  sendPulse(session);
}

async function sendPulse(session) {
  if (!isPlayingSession(session) || session.pulseInFlight) return;
  captureActiveTime(session, true);
  if (session.activeSincePulseMs < PULSE_INTERVAL_MS) return;

  session.pulseInFlight = true;
  session.pulseAttempts++;
  let failed = false;

  try {
    const token = await ensureListenToken(session);
    /* Token beklerken çalma durmuşsa pulse gönderilmez. Aynı pulse anahtarı
       oturum yeniden gerçekten playing olduğunda güvenle kullanılabilir. */
    if (!isPlayingSession(session)) return;

    /* Başarılı pulse'tan önce birikmiş gecikmeyi arka arkaya isteklerle
       telafi etmeyiz. Sunucunun son pulse zamanından sonra gerçekten çalınan
       süreyi koruyarak yaklaşık 10 saniyelik ritmi sürdürürüz. */
    const activeAtSend = session.activeSincePulseMs;
    const result = await api("/api/listens", {
      method: "POST",
      body: { action: "pulse", token },
    });

    captureActiveTime(session, isPlayingSession(session));
    session.activeSincePulseMs = Math.max(0, session.activeSincePulseMs - activeAtSend);
    session.pulseAttempts = 0;

    const accumulated = Number(result.accumulatedMs);
    if (Number.isFinite(accumulated) && accumulated >= 0) {
      session.serverAccumulatedMs = accumulated;
    }
    if (isCount(result.plays)) updateCounts({ plays: result.plays });
    if (isCount(result.trackPlays)) {
      const previous = state.trackStats.get(session.trackSlug);
      if (previous) {
        state.trackStats.set(session.trackSlug, {
          ...previous,
          plays: Number(result.trackPlays),
        });
        renderTrackEngagement(session.trackSlug);
      }
    }

    if (result.counted === true || session.serverAccumulatedMs >= session.thresholdMs) {
      session.completed = true;
      session.segmentStartedAt = null;
      stopListenTick();
    }
  } catch (_) {
    failed = true;
  } finally {
    session.pulseInFlight = false;
    if (failed) {
      schedulePulseRetry(session);
    } else if (!session.completed && isPlayingSession(session)) {
      if (session.activeSincePulseMs >= PULSE_INTERVAL_MS) maybePulse(session);
      else schedulePulseRetry(session);
    }
  }
}

function setupListenTracking() {
  if (!audio) return;

  audio.addEventListener("playing", () => {
    audioActuallyPlaying = true;
    resumeAfterSeek = false;
    startSegment();
  });
  for (const eventName of ["waiting", "stalled", "pause"]) {
    audio.addEventListener(eventName, () => {
      audioActuallyPlaying = false;
      stopSegment(currentListen);
    });
  }
  audio.addEventListener("seeking", () => {
    resumeAfterSeek = audioActuallyPlaying;
    audioActuallyPlaying = false;
    stopSegment(currentListen);
  });
  audio.addEventListener("seeked", () => {
    if (resumeAfterSeek && !audio.paused && audio.readyState >= 3) {
      audioActuallyPlaying = true;
      startSegment();
    }
    resumeAfterSeek = false;
  });
  for (const eventName of ["ended", "emptied", "abort", "error"]) {
    audio.addEventListener(eventName, () => {
      audioActuallyPlaying = false;
      resumeAfterSeek = false;
      finishCurrentListen();
    });
  }
  addEventListener("pagehide", () => {
    audioActuallyPlaying = false;
    stopSegment(currentListen);
  });
  addEventListener("pageshow", () => {
    /* bfcache dönüşünde gerçek `playing` olayı gelmeden süre biriktirilmez */
    if (audio.paused) audioActuallyPlaying = false;
  });
}

/* ── Başlangıç ve yeniden bağlanma ───────────────────────────── */
function scheduleBootstrapRetry() {
  if (state.unavailablePermanent || state.bootstrapRetryTimer) return;
  state.bootstrapRetryTimer = setTimeout(() => {
    state.bootstrapRetryTimer = 0;
    bootstrap();
  }, 30_000);
}

async function bootstrap() {
  if (state.bootstrapPromise || state.unavailablePermanent) return state.bootstrapPromise;
  state.apiAvailable = null;
  els.engagement.dataset.state = "loading";
  els.engagement.setAttribute("aria-busy", "true");
  els.list.setAttribute("aria-busy", "true");
  els.likeButton.disabled = true;
  setFormAvailable(false);
  setCommentsStatus("Topluluk bilgileri yükleniyor…");

  state.bootstrapPromise = (async () => {
    try {
      const result = await api("/api/engagement");
      if (!result.counts || !["plays", "likes", "comments"].every(key => isCount(result.counts[key]))) {
        throw new ApiError("Etkileşim yanıtı geçersiz.");
      }
      if (!setTrackEngagement(result.tracks)) {
        throw new ApiError("Parça etkileşim yanıtı geçersiz.");
      }
      state.liked = result.liked === true;
      updateCounts(result.counts);
      setAvailable();
      if (currentListen && canAccumulate()) startSegment();
      await loadComments({ reset: true });
    } catch (error) {
      setUnavailable(
        "Dinlenme, beğeni ve yorum bilgileri şu anda kullanılamıyor.",
        Boolean(error?.unavailable)
      );
      scheduleBootstrapRetry();
    } finally {
      state.bootstrapPromise = null;
    }
  })();

  return state.bootstrapPromise;
}

addEventListener("online", () => {
  if (state.bootstrapRetryTimer) {
    clearTimeout(state.bootstrapRetryTimer);
    state.bootstrapRetryTimer = 0;
  }
  if (state.apiAvailable !== true) bootstrap();
  if (currentListen && canAccumulate()) {
    if (currentListen.retryTimer) {
      clearTimeout(currentListen.retryTimer);
      currentListen.retryTimer = 0;
    }
    startSegment();
  }
});

populateTrackSelect();
setupListenTracking();
updateCounts();
renderAllTrackEngagement();

if (staticHost) {
  setUnavailable(
    "Dinlenme, beğeni ve yorum özellikleri bu yayında kullanılamıyor.",
    true
  );
} else {
  bootstrap();
}

})();
