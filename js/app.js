/* ═══════════════════════════════════════════════════════════════
   MİRAS — çalar, dalga formu, 3B kutu ve sahne efektleri
   ═══════════════════════════════════════════════════════════════ */
(() => {
"use strict";

const $  = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const audio     = $("#audio");
const preloader = new Audio();          // sıradaki şarkıyı önbelleğe alır
preloader.preload = "auto";
preloader.muted = true;

const els = {
  player:  $("#player"),
  list:    $("#tracklist"),
  wave:    $("#wave"),
  title:   $("#p-title"),
  sub:     $("#p-sub"),
  tCur:    $("#t-cur"),
  tTot:    $("#t-tot"),
  play:    $("#btn-play"),
  prev:    $("#btn-prev"),
  next:    $("#btn-next"),
  shuffle: $("#btn-shuffle"),
  repeat:  $("#btn-repeat"),
  repBadge:$("#repeat-badge"),
  mute:    $("#btn-mute"),
  vol:     $("#vol"),
  toast:   $("#toast"),
};

const fmt = s => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* ── Durum ─────────────────────────────────────────────────── */
let cur      = 0;          // aktif parça dizini
let started  = false;      // ilk çalma yapıldı mı
let shuffled = false;
let repeat   = 0;          // 0 kapalı · 1 tümü · 2 tek
let order    = TRACKS.map((_, i) => i);

/* ── Süre toplamları ───────────────────────────────────────── */
const totalSec = TRACKS.reduce((a, t) => a + t.dur, 0);
$("#stat-dur").textContent  = `${Math.round(totalSec / 60)} dk`;
$("#total-dur").textContent = `${Math.round(totalSec / 60)} dakika`;

/* ── Şarkı listesini kur ───────────────────────────────────── */
TRACKS.forEach((t, i) => {
  const li = document.createElement("li");
  li.className = "track";
  li.innerHTML = `
    <button class="track__btn" data-i="${i}"
            aria-label="${String(i + 1).padStart(2, "0")}. ${t.title}${t.variant ? " (" + t.variant + ")" : ""} — çal">
      <span class="track__num">
        <span class="num">${String(i + 1).padStart(2, "0")}.</span>
        <span class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
      </span>
      <span class="track__title">${t.title}
        ${t.variant ? `<span class="track__tag"${/classic/i.test(t.variant) ? ' lang="en"' : ""}>${t.variant}</span>` : ""}
      </span>
      <span class="track__dur">${fmt(t.dur)}</span>
      <span class="track__state" aria-hidden="true">
        <svg class="ic-hover" viewBox="0 0 24 24"><path d="M8 5.7v12.6c0 .8.9 1.3 1.6.9l10-6.3c.6-.4.6-1.4 0-1.8l-10-6.3c-.7-.4-1.6.1-1.6.9Z"/></svg>
      </span>
    </button>`;
  els.list.appendChild(li);
});
const rows = $$(".track", els.list);

/* ── Parça yükle / çal ─────────────────────────────────────── */
const srcOf = i => `audio/${TRACKS[i].slug}.mp3`;

function markRows() {
  rows.forEach((r, i) => {
    r.classList.toggle("track--active",  i === cur);
    r.classList.toggle("track--playing", i === cur && !audio.paused);
    r.classList.toggle("track--paused",  i === cur &&  audio.paused);
    if (i !== cur) r.querySelector(".track__btn").style.setProperty("--prog", 0);
  });
}

function loadTrack(i, autoplay) {
  cur = (i + TRACKS.length) % TRACKS.length;
  const t = TRACKS[cur];
  audio.src = srcOf(cur);
  audio.preload = "auto";
  audio.load();
  els.title.textContent = t.title + (t.variant ? ` · ${t.variant}` : "");
  els.tTot.textContent  = fmt(t.dur);
  els.tCur.textContent  = "0:00";
  history.replaceState(null, "", `#t${cur + 1}`);
  drawWave(0);
  markRows();
  setMediaSession(t);
  if (autoplay) safePlay();
}

function safePlay() {
  started = true;
  els.player.classList.add("player--on");
  audio.play().catch(err => {
    if (err.name !== "AbortError") toast("Çalma başlatılamadı — tekrar deneyin.");
    syncPlayIcon();
  });
}

const nextIndex = dir => {
  const pos = order.indexOf(cur);
  return order[(pos + dir + order.length) % order.length];
};

function goNext(user) {
  if (!user && repeat === 2) { audio.currentTime = 0; safePlay(); return; }
  const atEnd = order.indexOf(cur) === order.length - 1;
  if (!user && atEnd && repeat === 0) {          // albüm bitti
    loadTrack(order[0], false);
    syncPlayIcon();
    return;
  }
  loadTrack(nextIndex(1), true);
}
const goPrev = () => {
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  loadTrack(nextIndex(-1), true);
};

/* ── Çalar kontrolleri ─────────────────────────────────────── */
els.play.addEventListener("click", () => {
  if (!started) { loadTrack(cur, true); return; }
  audio.paused ? safePlay() : audio.pause();
});
els.next.addEventListener("click", () => goNext(true));
els.prev.addEventListener("click", goPrev);

els.shuffle.addEventListener("click", () => {
  shuffled = !shuffled;
  els.shuffle.setAttribute("aria-pressed", shuffled);
  if (shuffled) {
    order = TRACKS.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // aktif parça başa gelsin ki akış oradan sürsün
    order.splice(order.indexOf(cur), 1);
    order.unshift(cur);
    toast("Karışık çalma açık");
  } else {
    order = TRACKS.map((_, i) => i);
    toast("Karışık çalma kapalı");
  }
});

els.repeat.addEventListener("click", () => {
  repeat = (repeat + 1) % 3;
  els.repeat.setAttribute("aria-pressed", repeat > 0);
  els.repBadge.hidden = repeat !== 2;
  toast(repeat === 0 ? "Tekrar kapalı" : repeat === 1 ? "Albüm tekrarı açık" : "Tek şarkı tekrarı açık");
});

$$("[data-action='play-album']").forEach(b => b.addEventListener("click", () => {
  if (!started) loadTrack(0, true);
  else if (audio.paused) safePlay();
  $("#sarkilar").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
}));

els.list.addEventListener("click", e => {
  const btn = e.target.closest(".track__btn");
  if (!btn) return;
  const i = +btn.dataset.i;
  if (i === cur && started) { audio.paused ? safePlay() : audio.pause(); }
  else loadTrack(i, true);
});

/* ── Ses düzeyi ────────────────────────────────────────────── */
const setVolUI = () => {
  els.vol.style.setProperty("--vol", (audio.muted ? 0 : audio.volume) * 100 + "%");
  els.mute.style.opacity = audio.muted || audio.volume === 0 ? .45 : 1;
  els.mute.setAttribute("aria-label", audio.muted ? "Sesi aç" : "Sesi kapat");
};
audio.volume = +(localStorage.getItem("miras-vol") ?? .9);
els.vol.value = audio.volume;
setVolUI();
els.vol.addEventListener("input", () => {
  audio.volume = +els.vol.value;
  audio.muted = false;
  localStorage.setItem("miras-vol", els.vol.value);
  setVolUI();
});
els.mute.addEventListener("click", () => { audio.muted = !audio.muted; setVolUI(); });

/* ── Ses olayları ──────────────────────────────────────────── */
function syncPlayIcon() {
  const buffering = started && !audio.paused && audio.readyState < 3;
  els.play.dataset.state = buffering ? "spin" : (audio.paused ? "play" : "pause");
  els.play.setAttribute("aria-label", audio.paused ? "Çal" : "Duraklat");
}
["play", "pause", "playing", "waiting", "canplay"].forEach(ev =>
  audio.addEventListener(ev, () => { syncPlayIcon(); markRows(); }));

audio.addEventListener("playing", () => {
  document.title = `▶ ${TRACKS[cur].title} — MİRAS · Çağrı`;
  // sıradaki parçayı sessizce önbelleğe al
  const nxt = srcOf(nextIndex(1));
  if (!preloader.src.endsWith(nxt)) { preloader.src = nxt; preloader.load(); }
});
audio.addEventListener("pause", () => { document.title = "MİRAS — Çağrı | Albüm"; });
audio.addEventListener("ended", () => goNext(false));
audio.addEventListener("error", () => {
  if (!started) return;
  syncPlayIcon();
  toast("Şarkı yüklenemedi — bağlantınızı kontrol edin.");
});

audio.addEventListener("timeupdate", () => {
  els.tCur.textContent = fmt(audio.currentTime);
  const d = audio.duration || TRACKS[cur].dur;
  const p = d ? audio.currentTime / d : 0;
  rows[cur].querySelector(".track__btn").style.setProperty("--prog", p);
  if ("mediaSession" in navigator && audio.duration) {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 });
    } catch (_) {}
  }
});
audio.addEventListener("loadedmetadata", () => { els.tTot.textContent = fmt(audio.duration); });

/* ── Media Session (kilit ekranı kontrolleri) ──────────────── */
function setMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title + (t.variant ? ` (${t.variant})` : ""),
    artist: "Çağrı",
    album: "MİRAS",
    artwork: [
      { src: "img/artwork-192.jpg", sizes: "192x192", type: "image/jpeg" },
      { src: "img/artwork-512.jpg", sizes: "512x512", type: "image/jpeg" },
    ],
  });
  const H = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  H("play", safePlay);
  H("pause", () => audio.pause());
  H("previoustrack", goPrev);
  H("nexttrack", () => goNext(true));
  try { H("seekto", d => { if (d.seekTime != null) audio.currentTime = d.seekTime; }); } catch (_) {}
}

/* ── Dalga formu ───────────────────────────────────────────── */
const wctx = els.wave.getContext("2d");
let waveW = 0, waveH = 0, dpr = 1, hoverP = -1, lastDraw = -1;

function sizeWave() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  waveW = els.wave.clientWidth;
  waveH = els.wave.clientHeight;
  els.wave.width  = waveW * dpr;
  els.wave.height = waveH * dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lastDraw = -1;
  drawWave(progress());
}
const progress = () => {
  const d = audio.duration || TRACKS[cur].dur;
  return d ? (audio.currentTime / d) : 0;
};

function drawWave(p) {
  const peaks = TRACKS[cur].peaks;
  const n = Math.min(peaks.length, Math.max(60, Math.floor(waveW / 4)));
  const step = peaks.length / n;
  const bw = waveW / n;
  wctx.clearRect(0, 0, waveW, waveH);
  const gGold = wctx.createLinearGradient(0, 0, 0, waveH);
  gGold.addColorStop(0, "#ecd193"); gGold.addColorStop(.55, "#c9a35c"); gGold.addColorStop(1, "#8a6f3e");
  for (let i = 0; i < n; i++) {
    const v = peaks[Math.floor(i * step)] / 99;
    const h = Math.max(2, v * waveH * .94);
    const x = i * bw;
    const frac = i / n;
    if (frac <= p) wctx.fillStyle = gGold;
    else if (hoverP >= 0 && frac <= hoverP) wctx.fillStyle = "rgba(82,199,232,.4)";
    else wctx.fillStyle = "rgba(236,223,195,.16)";
    wctx.fillRect(x, (waveH - h) / 2, Math.max(1.4, bw - 1.6), h);
  }
}

function waveLoop() {
  const p = progress();
  if (Math.abs(p - lastDraw) > .0015 || hoverP >= 0) { drawWave(p); lastDraw = p; }
  requestAnimationFrame(waveLoop);
}
sizeWave();
requestAnimationFrame(waveLoop);
addEventListener("resize", sizeWave);

const seekAt = x => {
  const r = els.wave.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (x - r.left) / r.width));
  const d = audio.duration || TRACKS[cur].dur;
  if (!started) { loadTrack(cur, true); }
  audio.currentTime = p * d;
  drawWave(p);
};
let seeking = false;
els.wave.addEventListener("pointerdown", e => { seeking = true; els.wave.setPointerCapture(e.pointerId); seekAt(e.clientX); });
els.wave.addEventListener("pointermove", e => {
  if (seeking) seekAt(e.clientX);
  else {
    const r = els.wave.getBoundingClientRect();
    hoverP = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }
});
els.wave.addEventListener("pointerup",   () => { seeking = false; });
els.wave.addEventListener("pointerleave", () => { hoverP = -1; drawWave(progress()); });

/* ── Klavye kısayolları ────────────────────────────────────── */
addEventListener("keydown", e => {
  if (e.target.matches("input, textarea")) return;
  switch (e.code) {
    case "Space":      e.preventDefault(); els.play.click(); break;
    case "ArrowRight": if (started) audio.currentTime = Math.min((audio.duration || 1e9), audio.currentTime + 10); break;
    case "ArrowLeft":  if (started) audio.currentTime = Math.max(0, audio.currentTime - 10); break;
    case "ArrowUp":    e.preventDefault(); els.vol.value = Math.min(1, +els.vol.value + .06); els.vol.dispatchEvent(new Event("input")); break;
    case "ArrowDown":  e.preventDefault(); els.vol.value = Math.max(0, +els.vol.value - .06); els.vol.dispatchEvent(new Event("input")); break;
    case "KeyN":       goNext(true); break;
    case "KeyP":       goPrev(); break;
    case "KeyM":       els.mute.click(); break;
  }
});

/* ── Bildirim ──────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  els.toast.classList.add("toast--show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("toast--show"), 2600);
}

/* ── Derin bağlantı (#t7 gibi) ─────────────────────────────── */
{
  const m = location.hash.match(/^#t(\d{1,2})$/);
  if (m) {
    const i = Math.min(TRACKS.length, Math.max(1, +m[1])) - 1;
    cur = i;
  }
}
els.title.textContent = TRACKS[cur].title + (TRACKS[cur].variant ? ` · ${TRACKS[cur].variant}` : "");
els.tTot.textContent = fmt(TRACKS[cur].dur);
markRows();
els.player.classList.add("player--on");

/* sayfayla ilk temasta aktif parçayı arabelleğe almaya başla */
const warm = () => { audio.preload = "auto"; audio.load(); removeEventListener("pointerdown", warm); };
addEventListener("pointerdown", warm, { once: true, passive: true });

/* ── Üst çubuk ─────────────────────────────────────────────── */
const nav = $("#nav");
const onScroll = () => nav.classList.toggle("nav--solid", scrollY > 30);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ── Görünüm animasyonları ─────────────────────────────────── */
if (!reduceMotion && "IntersectionObserver" in window) {
  $$(".hero__text .reveal").forEach((el, i) => el.style.setProperty("--rd", (i * .1) + "s"));
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
  }, { threshold: .12 });
  $$(".reveal").forEach(el => io.observe(el));
} else {
  $$(".reveal").forEach(el => el.classList.add("in"));
}

/* ── 3B kutu etkileşimi ────────────────────────────────────── */
{
  const scene = $("#scene"), box = $("#case3d");
  let rx = 4, ry = -24, dragging = false, px = 0, py = 0, idleTimer;
  if (!reduceMotion) box.classList.add("is-idle");

  const setT = () => { box.style.transform = `rotateY(${ry}deg) rotateX(${rx}deg)`; };

  scene.addEventListener("pointerdown", e => {
    dragging = true; px = e.clientX; py = e.clientY;
    clearTimeout(idleTimer);
    // sürüklemeye o anki duruştan başla
    const st = getComputedStyle(box).transform;
    if (st && st !== "none") {
      const m = new DOMMatrixReadOnly(st);
      ry = Math.atan2(-m.m13, m.m11) * 180 / Math.PI;
      rx = Math.asin(Math.max(-1, Math.min(1, m.m23))) * -180 / Math.PI;
    }
    box.classList.remove("is-idle");
    box.style.transition = "none";
    setT();
    scene.setPointerCapture(e.pointerId);
  });
  scene.addEventListener("pointermove", e => {
    if (!dragging) return;
    ry += (e.clientX - px) * .45;
    rx  = Math.max(-16, Math.min(16, rx - (e.clientY - py) * .2));
    px = e.clientX; py = e.clientY;
    setT();
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    idleTimer = setTimeout(() => {
      box.style.transition = "transform 1.1s cubic-bezier(.22,.8,.3,1)";
      rx = 4.5; ry = -27; setT();
      setTimeout(() => {
        box.style.transition = "";
        box.style.transform = "";
        if (!reduceMotion) box.classList.add("is-idle");
      }, 1150);
    }, 2400);
  };
  scene.addEventListener("pointerup", release);
  scene.addEventListener("pointercancel", release);
}

/* ── Zerrecikler ───────────────────────────────────────────── */
if (!reduceMotion) {
  const cv = $("#dust"), ctx = cv.getContext("2d");
  let W, H, parts = [], running = true;

  const make = () => {
    const cyan = Math.random() < .16;
    return {
      x: Math.random() * W,
      y: H + Math.random() * H * .2,
      r: .6 + Math.random() * 1.5,
      v: .12 + Math.random() * .3,
      sway: 12 + Math.random() * 26,
      ph: Math.random() * Math.PI * 2,
      a: .1 + Math.random() * .35,
      cyan,
    };
  };
  const size = () => {
    const d = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * d; cv.height = H * d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const target = Math.round(W * H / 26000);
    parts = Array.from({ length: target }, () => {
      const p = make(); p.y = Math.random() * H; return p;
    });
  };
  size();
  addEventListener("resize", size);
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) tick();
  });

  let t = 0;
  function tick() {
    if (!running) return;
    t += .016;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.y -= p.v;
      const x = p.x + Math.sin(t * .7 + p.ph) * p.sway * .12;
      if (p.y < -8) Object.assign(p, make());
      ctx.globalAlpha = p.a;
      ctx.fillStyle = p.cyan ? "#52c7e8" : "#d9b877";
      ctx.beginPath();
      ctx.arc(x, p.y, p.r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }
  tick();
}

})();
