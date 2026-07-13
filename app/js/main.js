/* 묘연 · 오늘의 운세 타로 — 메인 로직
   플로우: S1 히어로 → S2 카테고리 → S3 셔플+스프레드+선택 → S4 리빌+결과
   원칙: 하루 1회 고정(localStorage), 모바일 터치 퍼스트, 픽셀 이벤트 스텁 */

const ASSET = "assets/cards/";
const IG_URL = "https://www.instagram.com/myoyeon.tarot";
const IG_DM = "https://ig.me/m/myoyeon.tarot";
const STORAGE_KEY = "myoyeon_daily_v1";

const $ = (sel) => document.querySelector(sel);

let state = { cat: null, card: null };

/* ── 픽셀 이벤트 (12단계에서 실제 Pixel ID 삽입 — index.html 주석 참고) ── */
function track(name, params) {
  const std = ["ViewContent", "InitiateCheckout", "Schedule", "Lead"];
  try {
    if (typeof fbq === "function") {
      std.includes(name) ? fbq("track", name, params) : fbq("trackCustom", name, params);
    }
  } catch (e) { /* pixel 미설치 시 무시 */ }
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    console.log("[track]", name, params || "");
  }
}

/* ── 하루 1회 고정 ── */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function loadToday() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.d === todayStr() && CARDS[saved.card]) return saved;
  } catch (e) { /* 무시 */ }
  return null;
}
function saveToday(cardId, cat) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ d: todayStr(), card: cardId, cat })); } catch (e) { /* 무시 */ }
}

/* ── 화면 전환 ── */
function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
  window.scrollTo(0, 0);
}

/* ── 배경 별 ── */
function makeStars() {
  const wrap = $("#stars");
  for (let i = 0; i < 42; i++) {
    const s = document.createElement("div");
    s.className = "star";
    const size = Math.random() * 2.2 + 0.8;
    s.style.cssText = `width:${size}px;height:${size}px;left:${Math.random() * 100}%;top:${Math.random() * 100}%;animation-delay:${Math.random() * 3.5}s;`;
    wrap.appendChild(s);
  }
}

/* ── S1 → S2 ── */
function initHero() {
  const saved = loadToday();
  if (saved) {
    $("#already-banner").classList.remove("hidden");
    $("#btn-start").textContent = "오늘의 카드 다시 보기";
    $("#btn-start").onclick = () => {
      state = { cat: saved.cat, card: saved.card };
      showResult(true);
    };
  } else {
    $("#btn-start").onclick = () => show("#s2");
  }
}

/* ── S2 카테고리 선택 ── */
function initCategory() {
  document.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.onclick = () => {
      state.cat = btn.dataset.cat;
      track("draw_start", { category: state.cat });
      startShuffle();
    };
  });
}

/* ── S3-A 셔플 ── */
function startShuffle() {
  show("#s3");
  $("#draw-hint").textContent = "묘연이가 카드를 섞고 있어요…";
  const stage = $("#shuffle-stage");
  stage.innerHTML = "";
  stage.classList.remove("hidden");
  $("#fan-wrap").classList.add("hidden");
  $("#scroll-hint").classList.add("hidden");

  for (let i = 0; i < 7; i++) {
    const c = document.createElement("div");
    c.className = "shuffle-card";
    c.style.backgroundImage = `url(${ASSET}back.webp)`;
    c.style.setProperty("--sx", (i - 3) * 16);
    c.style.setProperty("--sr", (i - 3) * 5);
    c.style.animationDelay = `${i * 0.06}s`;
    stage.appendChild(c);
  }
  setTimeout(spreadFan, 1600);
}

/* ── S3-B 스프레드 (터치 스크롤 + 탭 선택) ── */
function spreadFan() {
  $("#shuffle-stage").classList.add("hidden");
  $("#draw-hint").textContent = "마음이 가는 카드 한 장을 골라주세요";
  const wrap = $("#fan-wrap");
  const fan = $("#fan");
  fan.innerHTML = "";
  wrap.classList.remove("hidden");
  $("#scroll-hint").classList.remove("hidden");

  const N = 22;
  for (let i = 0; i < N; i++) {
    const c = document.createElement("div");
    c.className = "fan-card";
    c.style.backgroundImage = `url(${ASSET}back.webp)`;
    const t = i / (N - 1);                      // 0~1
    const arc = Math.sin(t * Math.PI) * -14;    // 가운데가 살짝 올라오는 아치
    c.style.setProperty("--r", `${(t - 0.5) * 10}deg`);
    c.style.setProperty("--y", `${arc}px`);
    c.style.animationDelay = `${i * 0.04}s`;
    c.classList.add("dealt");
    c.onclick = () => pickCard(c);
    fan.appendChild(c);
  }
  // 스프레드를 가운데부터 보여주기 (레이아웃 확정 후)
  setTimeout(() => { wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2; }, 80);
}

/* ── S3-C 카드 선택 → 중앙 이동(FLIP) ── */
function pickCard(el) {
  if (state.card !== null) return; // 중복 탭 방지
  // 카드는 탭 순간 무작위 결정 (위치와 무관 — 공정한 랜덤)
  state.card = crypto.getRandomValues(new Uint32Array(1))[0] % CARDS.length;

  $("#fan").style.pointerEvents = "none";
  $("#draw-hint").style.opacity = "0";
  $("#scroll-hint").classList.add("hidden");

  // 선택 카드 프론트 이미지 미리 로드
  const img = new Image();
  img.src = ASSET + CARDS[state.card].file + ".webp";

  // FLIP: 탭한 카드 위치에서 화면 중앙으로 클론 이동
  const rect = el.getBoundingClientRect();
  const clone = document.createElement("div");
  clone.className = "pick-clone";
  clone.style.backgroundImage = `url(${ASSET}back.webp)`;
  clone.style.cssText += `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
  document.body.appendChild(clone);
  el.style.opacity = "0";

  requestAnimationFrame(() => {
    const W = Math.min(window.innerWidth * 0.64, 250);
    const H = W * 1.5;
    clone.style.left = `${(window.innerWidth - W) / 2}px`;
    clone.style.top = `${Math.max((window.innerHeight - H) / 2 - 30, 24)}px`;
    clone.style.width = `${W}px`;
    clone.style.height = `${H}px`;
  });

  setTimeout(() => {
    clone.remove();
    showResult(false);
  }, 700);
}

/* ── S4 리빌 + 결과 ── */
function showResult(isReplay) {
  const card = CARDS[state.card];
  const cat = CATEGORIES[state.cat] || CATEGORIES.overall;

  $("#card-img").src = ASSET + card.file + ".webp";
  $("#card-img").alt = `${card.nameKo} 카드`;
  show("#s4");

  const inner = $("#flip-inner");
  const scene = $("#flip-scene");
  const body = $("#result-body");
  body.classList.add("hidden");
  $("#cta-bar").classList.add("hidden");
  inner.classList.remove("flipped");
  scene.classList.remove("glow");

  // 결과 본문 채우기
  $("#replay-banner").classList.toggle("hidden", !isReplay);
  $("#cat-label").textContent = `${cat.emoji} ${cat.title}`;
  $("#card-name").textContent = card.nameKo;
  $("#card-name-en").textContent = `${card.num} · ${card.nameEn}`;
  $("#keywords").innerHTML = card.keywords.map((k) => `<span class="kw">#${k}</span>`).join("");
  $("#reading").textContent = card.readings[state.cat] || card.readings.overall;
  $("#lucky").innerHTML = `<span>🎨 행운의 컬러 · ${card.lucky.color}</span><span>🍀 행운의 아이템 · ${card.lucky.item}</span>`;
  $("#advice-msg").textContent = `“${card.advice}”`;

  const reveal = () => {
    inner.classList.add("flipped");
    scene.classList.add("glow");
    burstSparkles(scene);
    setTimeout(() => {
      body.classList.remove("hidden");
      body.querySelectorAll(".fade-up").forEach((elm, i) => elm.style.setProperty("--fd", `${i * 0.12}s`));
      $("#cta-bar").classList.remove("hidden");
      track("ViewContent", { content_name: card.nameEn, content_category: state.cat });
    }, 1150);
  };

  if (isReplay) {
    // 재방문: 플립 없이 바로 앞면 + 본문
    inner.style.transition = "none";
    inner.classList.add("flipped");
    requestAnimationFrame(() => { inner.style.transition = ""; });
    body.classList.remove("hidden");
    $("#cta-bar").classList.remove("hidden");
    track("ViewContent", { content_name: card.nameEn, content_category: state.cat, replay: true });
  } else {
    saveToday(state.card, state.cat);
    setTimeout(reveal, 550);
  }
}

/* ── 별 파티클 버스트 ── */
function burstSparkles(scene) {
  const glyphs = ["✦", "✧", "✶", "·"];
  const colors = ["#E9B96E", "#A99BD6", "#F6EFE3"];
  for (let i = 0; i < 12; i++) {
    const sp = document.createElement("span");
    sp.className = "sparkle";
    sp.textContent = glyphs[i % glyphs.length];
    const ang = (i / 12) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 90 + Math.random() * 90;
    sp.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
    sp.style.setProperty("--dy", `${Math.sin(ang) * dist}px`);
    sp.style.setProperty("--sz", `${10 + Math.random() * 12}px`);
    sp.style.setProperty("--sc", colors[i % colors.length]);
    sp.style.setProperty("--sd", `${Math.random() * 0.25}s`);
    scene.appendChild(sp);
    setTimeout(() => sp.remove(), 1600);
  }
}

/* ── 공유 이미지 (9:16 캔버스) ── */
function makeShareImage() {
  const card = CARDS[state.card];
  const cat = CATEGORIES[state.cat] || CATEGORIES.overall;
  const cv = document.createElement("canvas");
  cv.width = 1080; cv.height = 1920;
  const ctx = cv.getContext("2d");

  // 배경
  const grad = ctx.createRadialGradient(540, 300, 100, 540, 800, 1400);
  grad.addColorStop(0, "#1A1F3D");
  grad.addColorStop(1, "#10142B");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1920);

  // 별
  ctx.fillStyle = "rgba(246,239,227,.5)";
  for (let i = 0; i < 60; i++) {
    ctx.globalAlpha = Math.random() * 0.6 + 0.15;
    ctx.beginPath();
    ctx.arc(Math.random() * 1080, Math.random() * 1920, Math.random() * 2.4 + 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    // 카드 (중앙 상단)
    const cw = 620, ch = 930, cx = (1080 - cw) / 2, cy = 210;
    ctx.save();
    ctx.shadowColor = "rgba(233,185,110,.45)";
    ctx.shadowBlur = 70;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx, cy, cw, ch, 26); else ctx.rect(cx, cy, cw, ch);
    ctx.clip();
    ctx.drawImage(img, cx, cy, cw, ch);
    ctx.restore();

    // 텍스트
    ctx.textAlign = "center";
    ctx.fillStyle = "#A99BD6";
    ctx.font = "500 34px Pretendard, sans-serif";
    ctx.fillText(`${cat.emoji} 오늘의 카드 · ${todayStr()}`, 540, 150);

    ctx.fillStyle = "#E9B96E";
    ctx.font = "700 76px 'Gowun Batang', serif";
    ctx.fillText(card.nameKo, 540, 1280);

    ctx.fillStyle = "rgba(246,239,227,.6)";
    ctx.font = "400 30px Pretendard, sans-serif";
    ctx.fillText(`${card.num} · ${card.nameEn}`, 540, 1336);

    ctx.fillStyle = "#F6EFE3";
    ctx.font = "500 38px Pretendard, sans-serif";
    ctx.fillText(card.keywords.map((k) => `#${k}`).join("   "), 540, 1440);

    ctx.fillStyle = "#A99BD6";
    ctx.font = "400 32px Pretendard, sans-serif";
    ctx.fillText("너도 오늘의 카드 뽑아봐 🌙", 540, 1700);
    ctx.fillStyle = "#E9B96E";
    ctx.font = "600 36px Pretendard, sans-serif";
    ctx.fillText("@myoyeon.tarot", 540, 1762);

    openShareModal(cv.toDataURL("image/png"));
    track("share_save", { content_name: card.nameEn });
  };
  img.src = ASSET + card.file + ".webp";
}

function openShareModal(dataUrl) {
  const modal = document.createElement("div");
  modal.id = "share-modal";
  modal.innerHTML = `
    <img src="${dataUrl}" alt="오늘의 카드 공유 이미지">
    <p>이미지를 길게 눌러 저장한 뒤,<br>인스타 스토리에 공유해 보세요 ✨</p>
    <button class="btn-ghost" id="share-close">닫기</button>`;
  document.body.appendChild(modal);
  $("#share-close").onclick = () => modal.remove();

  // 저장 버튼(다운로드 지원 브라우저)
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `myoyeon_${todayStr()}.png`;
  try { a.click(); } catch (e) { /* iOS 등은 길게 눌러 저장 */ }
}

/* ── 예약 바텀시트 (v1 스텁 — 8단계에서 자체 예약으로 교체) ── */
function openSheet() {
  track("InitiateCheckout", { content_name: "tarot_reading" });
  const dim = document.createElement("div");
  dim.id = "sheet-dim";
  const sheet = document.createElement("div");
  sheet.id = "sheet";
  sheet.innerHTML = `
    <h3>1:1 타로리딩 예약</h3>
    <p>공방에서 직접 만나 카드 너머의 이야기를 나눠요.<br>
       지금은 <b>인스타그램 DM</b>으로 예약을 도와드리고 있어요.</p>
    <a class="btn-primary" style="text-align:center;text-decoration:none" href="${IG_DM}" target="_blank" rel="noopener">인스타그램 DM으로 예약하기</a>
    <button class="btn-ghost" id="sheet-close">닫기</button>
    <p class="note">· 대면 리딩 전용 공방입니다 · 위치는 예약 확정 시 안내드려요</p>`;
  document.body.append(dim, sheet);
  const close = () => { dim.remove(); sheet.remove(); };
  dim.onclick = close;
  $("#sheet-close").onclick = close;
}

/* ── 초기화 ── */
document.addEventListener("DOMContentLoaded", () => {
  makeStars();
  initHero();
  initCategory();
  $("#btn-save").onclick = makeShareImage;
  $("#btn-book").onclick = openSheet;
  // 뒷면 이미지 프리로드
  const pre = new Image();
  pre.src = ASSET + "back.webp";
});
