/* 묘연 관리자탭 — A1 로그인 · A2 예약 · A3 시간표 · A4 통계
   알림은 반자동: 버튼 → sms: 링크로 문자앱이 내용 채워진 채 열림 (운영자 폰 기준) */

/* 공방 주소 — 확정·리마인드 문자에 들어감 */
const SHOP_ADDRESS = "경기도 안산시 단원구 광덕대로 168 (신화타운) 3층 멜로우스페이스";
const SITE_URL = location.origin;

/* 시간표 그리드: 10:00 ~ 21:30, 30분 간격 */
const TIMES = [];
for (let m = 10 * 60; m < 22 * 60; m += 30)
  TIMES.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const CAT_KO = { love: "💘 연애", money: "💰 금전", work: "💼 일·성장", overall: "✨ 총운" };
const $id = (s) => document.getElementById(s);

let resScope = "pending";
let slotData = { today: "", slots: [] }; // GET /api/admin/slots 응답 (현재 2주 창)
let selDate = "";
let baseToday = "";     // 서버 기준 오늘 (KST)
let rangeOffset = 0;    // 시간표 창 시작 오프셋 (0·14·28·42 — 최대 8주)
let toastTimer = null;

/* ── API 공통 ── */
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error("로그인이 필요해요."); }
  if (!res.ok) throw new Error(data.message || "요청에 실패했어요.");
  return data;
}

/* ── 표기 유틸 ── */
const fmtMD = (d) => { const p = d.split("-"); return `${Number(p[1])}/${Number(p[2])}`; };
const dowOf = (d) => DOW[new Date(`${d}T12:00:00+09:00`).getDay()];
const fmtFull = (d, t) => `${fmtMD(d)}(${dowOf(d)}) ${t}`;
function fmtCreated(utc) { // D1 datetime('now')는 UTC → KST 표시
  try {
    return new Date(utc.replace(" ", "T") + "Z").toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch (e) { return utc; }
}
function addDaysStr(dateStr, n) {
  const p = dateStr.split("-").map(Number);
  const dt = new Date(p[0], p[1] - 1, p[2] + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── 원클릭 문자 (sms: 링크 — iOS는 &body, 그 외 ?body) ── */
function smsHref(phone, body) {
  const sep = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?";
  return `sms:${phone.replace(/\D/g, "")}${sep}body=${encodeURIComponent(body)}`;
}
const tmpl = {
  confirm: (r) => `[타로공방 묘연] ${r.name}님, ${fmtFull(r.date, r.time)} 타로리딩 예약이 확정되었어요 🌙 (30분·5,000원·현장결제)\n공방 위치: ${SHOP_ADDRESS}\n변경이나 궁금한 점은 이 번호로 답장 주세요!`,
  remind: (r) => `[타로공방 묘연] ${r.name}님, ${fmtFull(r.date, r.time)} 타로리딩으로 뵈어요 🌙\n오시는 길: ${SHOP_ADDRESS}`,
  cancel: (r) => `[타로공방 묘연] ${r.name}님, 죄송하게도 ${fmtFull(r.date, r.time)} 시간 예약이 어려워졌어요 🙏 아래 링크에서 다른 시간으로 다시 신청 부탁드려요.\n${SITE_URL}`,
};

function toast(html, ms = 5000) {
  const el = $id("toast");
  el.innerHTML = html;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* ── A1 로그인 ── */
function showLogin() {
  $id("app").classList.add("hidden");
  $id("login").classList.remove("hidden");
  setTimeout(() => $id("pw").focus(), 50);
}
async function tryLogin() {
  $id("login-msg").textContent = "";
  try {
    await api("/admin/login", { method: "POST", body: { password: $id("pw").value } });
    $id("pw").value = "";
    enterApp();
  } catch (e) {
    $id("login-msg").textContent = e.message;
  }
}
function enterApp() {
  $id("login").classList.add("hidden");
  $id("app").classList.remove("hidden");
  loadAll();
}

/* ── 데이터 로드 ── */
async function loadAll() {
  await Promise.all([loadReservations(), loadSlots(), loadStats()]);
}
async function loadReservations() {
  const list = $id("res-list");
  try {
    const data = await api(`/admin/reservations?scope=${resScope}`);
    renderReservations(data.reservations, data.today);
  } catch (e) {
    list.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}
async function loadSlots() {
  try {
    const from = baseToday ? addDaysStr(baseToday, rangeOffset) : "";
    slotData = await api(`/admin/slots${from ? `?from=${from}&days=14` : ""}`);
    if (!baseToday) baseToday = slotData.today;
    const winStart = slotData.from || slotData.today;
    if (!selDate || selDate < winStart || selDate > addDaysStr(winStart, 13)) selDate = winStart;
    renderPager(winStart);
    renderSlotDates(winStart);
    renderSlotGrid();
  } catch (e) { /* 401은 showLogin 처리됨 */ }
}
async function loadStats() {
  try {
    const s = await api("/admin/stats");
    renderStats(s);
  } catch (e) { /* 무시 */ }
  try {
    renderTg(await api("/admin/telegram/status"));
  } catch (e) { /* 무시 */ }
}

/* ── A2 예약 렌더 ── */
function renderReservations(rows, today) {
  const list = $id("res-list");
  if (!rows.length) {
    const msg = { pending: "대기 중인 신청이 없어요 🌙", upcoming: "예정된 확정 예약이 없어요", all: "아직 예약이 없어요" };
    list.innerHTML = `<p class="empty">${msg[resScope]}</p>`;
    return;
  }
  list.innerHTML = rows.map((r) => {
    const badge = { pending: "대기", approved: "확정", cancelled: "취소" }[r.status];
    const isTomorrow = r.date === addDaysStr(today, 1);
    let actions = "";
    if (r.status === "pending") {
      actions = `
        <button class="act ok" onclick="actApprove(${r.id})">✅ 승인</button>
        <button class="act bad" onclick="actCancel(${r.id}, true)">거절</button>`;
    } else if (r.status === "approved") {
      actions = `
        <a class="act sms" href="${smsHref(r.phone, tmpl.confirm(r))}">📩 확정 문자</a>
        ${isTomorrow ? `<a class="act sms" href="${smsHref(r.phone, tmpl.remind(r))}">⏰ 리마인드</a>` : ""}
        <button class="act bad" onclick="actCancel(${r.id}, false)">취소</button>`;
    } else {
      actions = `<a class="act" href="${smsHref(r.phone, tmpl.cancel(r))}">📩 취소 안내 문자</a>`;
    }
    return `
      <div class="res-card">
        <div class="res-top">
          <span class="badge ${r.status}">${badge}</span>
          <span class="res-when">${fmtFull(r.date, r.time)}</span>
          <span class="res-created">신청 ${fmtCreated(r.created_at)}</span>
        </div>
        <div class="res-who">${esc(r.name)} · <a href="tel:${r.phone.replace(/\D/g, "")}">${r.phone}</a>
          ${r.category ? `<span class="res-cat"> · ${CAT_KO[r.category] || ""}</span>` : ""}
          ${r.assignee_name ? `<span class="res-cat"> · 🙋 담당 ${esc(r.assignee_name)}</span>` : ""}
          ${r.source ? `<span class="res-cat"> · 📍 ${esc(r.source)}</span>` : ""}</div>
        ${r.note ? `<div class="res-note">💬 ${esc(r.note)}</div>` : ""}
        <div class="res-actions">${actions}</div>
      </div>`;
  }).join("");
}

/* ── A2 액션 ── */
async function actApprove(id) {
  try {
    const r = await api(`/admin/reservations/${id}`, { method: "POST", body: { action: "approve" } });
    await Promise.all([loadReservations(), loadSlots()]);
    toast(`✅ 승인 완료 — <a href="${smsHref(r.phone, tmpl.confirm(r))}">확정 문자 보내기 📩</a>`, 9000);
  } catch (e) { toast(esc(e.message)); }
}
async function actCancel(id, isReject) {
  const q = isReject ? "이 신청을 거절할까요?" : "확정된 예약을 취소할까요? 그 시간은 다시 열려요.";
  if (!confirm(q)) return;
  try {
    const r = await api(`/admin/reservations/${id}`, { method: "POST", body: { action: "cancel" } });
    await Promise.all([loadReservations(), loadSlots()]);
    toast(`처리 완료 — <a href="${smsHref(r.phone, tmpl.cancel(r))}">안내 문자 보내기 📩</a>`, 9000);
  } catch (e) { toast(esc(e.message)); }
}
window.actApprove = actApprove;
window.actCancel = actCancel;

/* ── A3 시간표 렌더 (2주 창 · 8주 페이징) ── */
function renderPager(winStart) {
  $id("range-label").textContent = `${fmtMD(winStart)} ~ ${fmtMD(addDaysStr(winStart, 13))}`;
  $id("btn-prev-w").disabled = rangeOffset <= 0;
  $id("btn-next-w").disabled = rangeOffset >= 42;
}
function renderSlotDates(winStart) {
  const wrap = $id("slot-dates");
  wrap.innerHTML = "";
  for (let i = 0; i < 14; i++) {
    const d = addDaysStr(winStart, i);
    const openCnt = slotData.slots.filter((s) => s.date === d).length;
    const btn = document.createElement("button");
    btn.className = "chip" + (d === selDate ? " on" : "");
    btn.innerHTML = `${fmtMD(d)} ${d === baseToday ? "오늘" : dowOf(d)}<small>${openCnt ? openCnt + "칸 열림" : "닫힘"}</small>`;
    btn.onclick = () => { selDate = d; renderSlotDates(winStart); renderSlotGrid(); };
    wrap.appendChild(btn);
  }
}
function renderSlotGrid() {
  const grid = $id("slot-grid");
  grid.innerHTML = "";
  const daySlots = {};
  slotData.slots.filter((s) => s.date === selDate).forEach((s) => { daySlots[s.time] = s; });

  TIMES.forEach((t) => {
    const s = daySlots[t];
    const btn = document.createElement("button");
    if (s && s.res_id) {
      btn.className = "slot booked";
      btn.innerHTML = `${t}<small>${esc(s.res_name)}${s.res_status === "pending" ? " (대기)" : ""}</small>`;
      btn.onclick = () => toast(`${esc(s.res_name)}님 예약이 있어요. 닫으려면 예약 탭에서 먼저 취소해 주세요.`);
    } else {
      const isOpen = !!s;
      btn.className = "slot" + (isOpen ? " open" : "");
      btn.textContent = t;
      btn.onclick = () => toggleSlots([t], !isOpen);
    }
    grid.appendChild(btn);
  });
}
async function toggleSlots(times, open) {
  try {
    const r = await api("/admin/slots", { method: "POST", body: { date: selDate, times, open } });
    await loadSlots();
    if (!open && r.locked) toast(`예약이 잡힌 ${r.locked}칸은 남겨뒀어요.`);
  } catch (e) { toast(esc(e.message)); }
}

/* ── A4 통계 렌더 ── */
function renderStats(s) {
  $id("stat-cards").innerHTML = `
    <div class="stat"><b>${s.reservations.pending}</b><span>승인 대기</span></div>
    <div class="stat"><b>${s.reservations.upcoming}</b><span>확정 · 예정</span></div>
    <div class="stat"><b>${s.reservations.week}</b><span>최근 7일 신청</span></div>`;

  const steps = [
    ["방문", "page_view"], ["뽑기 시작", "draw_start"], ["결과 확인", "result_view"],
    ["예약 열람", "booking_open"], ["예약 신청", "booking_submit"],
  ];
  const rows = steps.map(([label, key], i) => {
    const t = s.funnelToday[key] || 0;
    const w = s.funnelWeek[key] || 0;
    const prevW = i === 0 ? 0 : (s.funnelWeek[steps[i - 1][1]] || 0);
    const pct = i === 0 || !prevW ? "" : `<span class="pct">${Math.round((w / prevW) * 100)}%</span>`;
    return `<tr><td>${label}</td><td>${t}</td><td>${w} ${pct}</td></tr>`;
  }).join("");
  $id("funnel").innerHTML = `<tr><th>단계</th><th>오늘</th><th>7일 (전환)</th></tr>${rows}`;

  // 유입 경로 (9단계 — planning/09 §2 링크 맵과 표기 동일)
  const srcRows = (s.sourcesWeek || [])
    .map((r) => `<tr><td>${esc(r.src)}</td><td>${r.visits}</td><td>${r.bookings}</td></tr>`)
    .join("");
  $id("sources").innerHTML = `<tr><th>유입</th><th>방문</th><th>신청</th></tr>` +
    (srcRows || `<tr><td colspan="3" class="empty-cell">아직 유입 데이터가 없어요</td></tr>`);
}

/* ── A4 텔레그램 봇 연결 ── */
function renderTg(t) {
  const box = $id("tg-box");
  if (!t.configured) {
    box.innerHTML = `아직 봇 토큰이 없어요.<br><small>텔레그램 <b>@BotFather</b>에서 봇 생성 → Cloudflare(myoyeon → Settings)에
      <b>TELEGRAM_BOT_TOKEN</b> 시크릿 추가 → 봇을 타로사 그룹에 초대 → 여기서 연결 (절차: planning/08 §8)</small>`;
    return;
  }
  box.innerHTML = t.connected
    ? `✅ 연결됨 · <b>${esc(t.chat_title || "그룹")}</b><button class="mini" id="btn-tg-setup">재연결</button>`
    : `토큰 확인 완료 — 이제 그룹만 연결하면 돼요.<button class="mini" id="btn-tg-setup">그룹 연결하기</button><br>
       <small>봇을 타로사 그룹에 초대하고, 그룹에 <b>/start</b> 를 보낸 뒤 누르세요.</small>`;
  const btn = $id("btn-tg-setup");
  if (btn) btn.onclick = tgConnect;
}
async function tgConnect() {
  toast("텔레그램 연결 중…");
  try {
    const r = await api("/admin/telegram/setup", { method: "POST", body: {} });
    toast(`✅ 연결 완료 — <b>${esc(r.chat_title || "그룹")}</b>에 확인 메시지를 보냈어요`, 7000);
  } catch (e) {
    toast(esc(e.message), 9000);
  }
  loadStats();
}

/* ── 탭 · 초기화 ── */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    ["res", "slots", "stats"].forEach((k) => $id("tab-" + k).classList.toggle("hidden", tab.dataset.tab !== k));
  };
});
document.querySelectorAll("#tab-res .chip").forEach((chip) => {
  chip.onclick = () => {
    document.querySelectorAll("#tab-res .chip").forEach((c) => c.classList.toggle("on", c === chip));
    resScope = chip.dataset.scope;
    loadReservations();
  };
});
$id("btn-login").onclick = tryLogin;
$id("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });
$id("btn-refresh").onclick = loadAll;
$id("btn-logout").onclick = async () => {
  try { await api("/admin/logout", { method: "POST" }); } catch (e) { /* 무시 */ }
  showLogin();
};
$id("btn-prev-w").onclick = () => { rangeOffset = Math.max(0, rangeOffset - 14); selDate = ""; loadSlots(); };
$id("btn-next-w").onclick = () => { rangeOffset = Math.min(42, rangeOffset + 14); selDate = ""; loadSlots(); };
$id("btn-open-all").onclick = () => {
  const openTimes = new Set(slotData.slots.filter((s) => s.date === selDate).map((s) => s.time));
  const toOpen = TIMES.filter((t) => !openTimes.has(t));
  if (toOpen.length) toggleSlots(toOpen, true);
};
$id("btn-close-all").onclick = () => {
  if (confirm(`${fmtMD(selDate)}(${dowOf(selDate)}) 시간을 모두 닫을까요? (예약된 칸은 유지돼요)`)) toggleSlots(TIMES, false);
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$id("app").classList.contains("hidden")) loadAll();
});

/* 세션 확인 후 진입 (미로그인·미설정 모두 로그인 화면으로) */
(async () => {
  try { await api("/admin/me"); enterApp(); }
  catch (e) { showLogin(); }
})();
