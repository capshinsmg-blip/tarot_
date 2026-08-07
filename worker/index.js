/* 묘연 · 예약 백엔드 (Cloudflare Worker + D1)
   라우팅: 정적 에셋(app/)이 먼저 매치되고, 남는 요청(/api/*)이 여기로 온다.
   D1 미연결(env.DB 없음) 시 모든 API가 503 → 프론트는 인스타 DM 안내로 폴백.
   스키마는 첫 요청 시 자동 생성 (worker/schema.sql은 참고용) */

const ACTIVE = "('pending','approved')"; // 슬롯을 점유하는 예약 상태
const EVENT_NAMES = new Set(["page_view", "draw_start", "result_view", "booking_open", "booking_submit", "share_save", "popup_view", "popup_click"]);
const CATEGORIES = new Set(["love", "money", "work", "overall"]);
const BOOK_LEAD_MIN = 60;        // 슬롯 시작 60분 전까지만 신청 가능
const MAX_ACTIVE_PER_PHONE = 2;  // 전화번호당 활성 예약 상한 (스팸 방지)
const DAYS_AHEAD = 14;           // 손님에게 노출되는 예약 창
const ADMIN_DAYS_AHEAD = 56;     // 관리자 시간표 관리 범위 (8주 — 다음 달 선반영)
const COOKIE = "myo_admin";
const CAT_KO = { love: "💘 연애", money: "💰 금전", work: "💼 일·성장", overall: "✨ 총운" };

/* 기본 영업 그리드: 10:00 ~ 21:30, 30분 간격 — 모든 칸이 기본 '열림'.
   관리자가 닫은 칸만 closed_slots(블록리스트)에 기록된다. */
const GRID_TIMES = [];
for (let m = 10 * 60; m < 22 * 60; m += 30)
  GRID_TIMES.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      // 에셋에 없는 경로 → 홈으로 (오탈자 링크 방어)
      return Response.redirect(new URL("/", url).toString(), 302);
    }
    try {
      return await handleApi(req, env, ctx, url);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
      console.error("API error:", e);
      return json({ error: "internal", message: "잠시 후 다시 시도해 주세요." }, 500);
    }
  },
};

async function handleApi(req, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  if (path === "/api/health") return json({ ok: true, db: !!env.DB, admin: !!env.ADMIN_PASSWORD });
  if (!env.DB) throw new ApiError(503, "setup_required", "예약 시스템 준비 중이에요. 인스타 DM으로 문의해 주세요.");
  await ensureSchema(env);

  // ── 공개 API ──
  if (path === "/api/event" && method === "POST") return apiEvent(req, env);
  if (path === "/api/slots" && method === "GET") return apiSlots(env);
  if (path === "/api/reservations" && method === "POST") return apiCreateReservation(req, env, ctx);
  if (path === "/api/telegram/webhook" && method === "POST") return tgWebhook(req, env); // 시크릿 헤더로 자체 인증

  // ── 관리자 API ──
  if (path === "/api/admin/login" && method === "POST") return adminLogin(req, env, url);
  if (path.startsWith("/api/admin/")) {
    if (!(await isAdmin(req, env))) throw new ApiError(401, "unauthorized", "로그인이 필요해요.");
    if (path === "/api/admin/logout" && method === "POST") return adminLogout(url);
    if (path === "/api/admin/me" && method === "GET") return json({ ok: true });
    if (path === "/api/admin/reservations" && method === "GET") return adminListReservations(env, url);
    const m = path.match(/^\/api\/admin\/reservations\/(\d+)$/);
    if (m && method === "POST") return adminUpdateReservation(req, env, ctx, Number(m[1]));
    if (path === "/api/admin/slots" && method === "GET") return adminListSlots(env, url);
    if (path === "/api/admin/slots" && method === "POST") return adminToggleSlots(req, env);
    if (path === "/api/admin/stats" && method === "GET") return adminStats(env);
    if (path === "/api/admin/telegram/status" && method === "GET") return tgStatus(env);
    if (path === "/api/admin/telegram/setup" && method === "POST") return tgSetup(env, url);
  }
  throw new ApiError(404, "not_found", "없는 API예요.");
}

/* ── 스키마 자동 생성 (isolate당 1회) ── */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, time))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ux_active_slot
      ON reservations(slot_id) WHERE status IN ${ACTIVE}`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_events_date ON events(date, name)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS closed_slots (
      date TEXT NOT NULL, time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (date, time))`),
  ]);
  // v2 마이그레이션: 담당 타로사 · 텔레그램 메시지 (이미 있으면 duplicate 에러 → 무시)
  // v3 (9단계): source — 유입 경로 (instagram/bio, meta/paid …)
  for (const col of ["assignee_name TEXT", "assignee_tg TEXT", "tg_msg_id TEXT", "source TEXT"]) {
    try { await env.DB.prepare(`ALTER TABLE reservations ADD COLUMN ${col}`).run(); }
    catch (e) { /* duplicate column */ }
  }
  try { await env.DB.prepare("ALTER TABLE events ADD COLUMN source TEXT").run(); }
  catch (e) { /* duplicate column */ }
  schemaReady = true;
}

/* ── 설정 저장소 (텔레그램 chat_id 등) ── */
async function getSetting(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first();
  return r ? r.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2"
  ).bind(key, value).run();
}

/* ── 시간 유틸 (KST 고정 — 워커는 UTC로 돈다) ── */
function kstParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}
function addDays(dateStr, n) {
  const d = new Date(Date.parse(`${dateStr}T12:00:00+09:00`) + n * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}
function slotEpoch(date, time) {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/* ── 공통 헬퍼 ── */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}
async function readJson(req) {
  try { return await req.json(); }
  catch (e) { throw new ApiError(400, "bad_json", "요청 형식이 올바르지 않아요."); }
}
function normPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!/^01[016789]\d{7,8}$/.test(d)) return null;
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
function normSource(raw) { // "instagram/bio" 형식만 통과 (planning/09 §2)
  return String(raw || "").slice(0, 40).replace(/[^\w/-]/g, "");
}

/* ── 공개: 퍼널 이벤트 ── */
async function apiEvent(req, env) {
  const b = await readJson(req);
  if (!EVENT_NAMES.has(b.name)) return json({ ok: false });
  await env.DB.prepare("INSERT INTO events (name, date, source) VALUES (?1, ?2, ?3)")
    .bind(b.name, kstParts().date, normSource(b.source)).run();
  return json({ ok: true });
}

/* ── 공개: 예약 가능 슬롯 (기본 전체 열림 − 닫힘 블록리스트 − 예약됨 − 마감) ── */
async function apiSlots(env) {
  const today = kstParts().date;
  const end = addDays(today, DAYS_AHEAD - 1);
  const closed = await env.DB.prepare(
    "SELECT date, time FROM closed_slots WHERE date BETWEEN ?1 AND ?2"
  ).bind(today, end).all();
  const booked = await env.DB.prepare(
    `SELECT s.date, s.time FROM slots s
     JOIN reservations r ON r.slot_id = s.id AND r.status IN ${ACTIVE}
     WHERE s.date BETWEEN ?1 AND ?2`
  ).bind(today, end).all();
  const block = new Set([...closed.results, ...booked.results].map((x) => `${x.date} ${x.time}`));
  const minEpoch = Date.now() + BOOK_LEAD_MIN * 60000;
  const slots = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    for (const t of GRID_TIMES) {
      if (block.has(`${d} ${t}`)) continue;
      if (slotEpoch(d, t) < minEpoch) continue;
      slots.push({ date: d, time: t });
    }
  }
  return json({ ok: true, today, slots });
}

/* ── 공개: 예약 신청 ── */
async function apiCreateReservation(req, env, ctx) {
  const b = await readJson(req);
  if (b.website) return json({ ok: true, id: 0 }); // 허니팟 — 봇에게는 성공한 척

  const name = String(b.name || "").trim();
  const phone = normPhone(b.phone);
  const note = String(b.note || "").trim().slice(0, 200);
  const category = CATEGORIES.has(b.category) ? b.category : "";
  const source = normSource(b.source);

  if (!name || name.length > 20) throw new ApiError(400, "bad_name", "이름을 1~20자로 입력해 주세요.");
  if (!phone) throw new ApiError(400, "bad_phone", "연락처를 확인해 주세요. (예: 010-1234-5678)");
  if (b.consent !== true) throw new ApiError(400, "consent_required", "개인정보 수집 동의가 필요해요.");

  // 신청 시간: {date, time} 기반 (구버전 캐시 프론트의 slot_id도 허용)
  let date = String(b.date || "");
  let time = String(b.time || "");
  const legacyId = Number(b.slot_id);
  if ((!date || !time) && Number.isInteger(legacyId) && legacyId > 0) {
    const legacy = await env.DB.prepare("SELECT date, time FROM slots WHERE id = ?1").bind(legacyId).first();
    if (legacy) { date = legacy.date; time = legacy.time; }
  }
  const today = kstParts().date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !GRID_TIMES.includes(time))
    throw new ApiError(400, "bad_slot", "예약 시간을 선택해 주세요.");
  if (date < today || date > addDays(today, DAYS_AHEAD - 1))
    throw new ApiError(409, "slot_closed", "그 날짜는 아직 예약이 열리지 않았어요. 다른 날짜를 골라주세요.");
  if (slotEpoch(date, time) < Date.now() + BOOK_LEAD_MIN * 60000)
    throw new ApiError(409, "slot_closed", "그 시간은 신청이 마감됐어요. 다른 시간을 골라주세요.");
  const isClosed = await env.DB.prepare(
    "SELECT 1 AS x FROM closed_slots WHERE date = ?1 AND time = ?2"
  ).bind(date, time).first();
  if (isClosed) throw new ApiError(409, "slot_closed", "그 시간은 예약을 받지 않아요. 다른 시간을 골라주세요.");

  const dup = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM reservations r JOIN slots s ON s.id = r.slot_id
     WHERE r.phone = ?1 AND r.status IN ${ACTIVE} AND s.date >= ?2`
  ).bind(phone, today).first();
  if (dup.c >= MAX_ACTIVE_PER_PHONE)
    throw new ApiError(409, "too_many", "확인 대기 중인 예약이 이미 있어요. 확정 안내 후 다시 신청해 주세요.");

  // 슬롯 앵커 확보 (없으면 생성) — 더블부킹은 예약 테이블의 부분 유니크 인덱스가 막는다
  await env.DB.prepare("INSERT OR IGNORE INTO slots (date, time) VALUES (?1, ?2)").bind(date, time).run();
  const slot = await env.DB.prepare("SELECT id, date, time FROM slots WHERE date = ?1 AND time = ?2").bind(date, time).first();
  if (!slot) throw new ApiError(500, "internal", "잠시 후 다시 시도해 주세요.");

  let id;
  try {
    const r = await env.DB.prepare(
      "INSERT INTO reservations (slot_id, name, phone, note, category, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(slot.id, name, phone, note, category, source).run();
    id = r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "slot_taken", "아쉽지만 방금 다른 분이 그 시간을 신청했어요. 다른 시간을 골라주세요.");
    throw e;
  }

  ctx.waitUntil(notifyAdmin(env, { name, phone, note, date: slot.date, time: slot.time }));
  ctx.waitUntil(notifyTelegram(env, { id, name, note, category, date: slot.date, time: slot.time }));
  return json({ ok: true, id, name, date: slot.date, time: slot.time });
}

/* ── 신규 신청 이메일 알림 (선택 — RESEND_API_KEY + ADMIN_EMAIL 설정 시) ── */
async function notifyAdmin(env, r) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "묘연 예약 <onboarding@resend.dev>",
        to: [env.ADMIN_EMAIL],
        subject: `[묘연] 새 예약 신청 — ${r.name} · ${r.date} ${r.time}`,
        text: `이름: ${r.name}\n연락처: ${r.phone}\n일시: ${r.date} ${r.time}\n문의: ${r.note || "-"}\n\n관리자탭에서 승인해 주세요: /admin/`,
      }),
    });
  } catch (e) { console.error("notifyAdmin fail:", e); }
}

/* ── 관리자 인증 (비밀번호 1개 → HMAC 토큰 쿠키 30일) ── */
async function adminToken(env) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ADMIN_PASSWORD),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("myoyeon-admin-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function isAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  if (!m) return false;
  return timingSafeEq(m[1], await adminToken(env));
}
function cookieAttrs(url, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function adminLogin(req, env, url) {
  if (!env.ADMIN_PASSWORD)
    throw new ApiError(503, "setup_required", "ADMIN_PASSWORD 시크릿이 아직 설정되지 않았어요. (Cloudflare → Workers → myoyeon → Settings)");
  const b = await readJson(req);
  const pw = String(b.password || "");
  if (!pw || !timingSafeEq(pw.padEnd(64, "\0"), env.ADMIN_PASSWORD.padEnd(64, "\0"))) {
    await new Promise((r) => setTimeout(r, 400)); // 무차별 대입 감속
    throw new ApiError(401, "wrong_password", "비밀번호가 맞지 않아요.");
  }
  const token = await adminToken(env);
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=${token}; ${cookieAttrs(url, 2592000)}` });
}
function adminLogout(url) {
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; ${cookieAttrs(url, 0)}` });
}

/* ── 관리자: 예약 목록 ── */
async function adminListReservations(env, url) {
  const scope = url.searchParams.get("scope") || "pending";
  const today = kstParts().date;
  const base = `SELECT r.id, r.name, r.phone, r.note, r.category, r.status, r.created_at, r.assignee_name, r.source, s.date, s.time
                FROM reservations r JOIN slots s ON s.id = r.slot_id`;
  let q;
  if (scope === "pending") q = env.DB.prepare(`${base} WHERE r.status = 'pending' ORDER BY s.date, s.time`);
  else if (scope === "upcoming") q = env.DB.prepare(`${base} WHERE r.status = 'approved' AND s.date >= ?1 ORDER BY s.date, s.time`).bind(today);
  else q = env.DB.prepare(`${base} ORDER BY r.created_at DESC LIMIT 300`);
  const rs = await q.all();
  return json({ ok: true, today, reservations: rs.results });
}

/* ── 관리자: 승인/취소 ── */
async function adminUpdateReservation(req, env, ctx, id) {
  const b = await readJson(req);
  const action = b.action;
  if (!["approve", "cancel"].includes(action)) throw new ApiError(400, "bad_action", "approve 또는 cancel만 가능해요.");
  const row = await env.DB.prepare(
    `SELECT r.id, r.status, r.name, r.phone, r.assignee_name, r.tg_msg_id, s.date, s.time
     FROM reservations r JOIN slots s ON s.id = r.slot_id WHERE r.id = ?1`
  ).bind(id).first();
  if (!row) throw new ApiError(404, "not_found", "해당 예약이 없어요.");
  if (action === "approve" && row.status !== "pending")
    throw new ApiError(409, "bad_state", `대기 상태가 아니에요. (현재: ${row.status})`);
  if (action === "cancel" && row.status === "cancelled")
    throw new ApiError(409, "bad_state", "이미 취소된 예약이에요.");
  const status = action === "approve" ? "approved" : "cancelled";
  await env.DB.prepare("UPDATE reservations SET status = ?1, updated_at = datetime('now') WHERE id = ?2")
    .bind(status, id).run();
  ctx.waitUntil(tgStatusPost(env, { ...row, status })); // 타로사 그룹에 상태 공유
  return json({ ok: true, id, status, name: row.name, phone: row.phone, date: row.date, time: row.time });
}

/* ── 관리자: 슬롯 그리드 조회 (2주 창, 8주 범위 내 페이징) ── */
async function adminListSlots(env, url) {
  const today = kstParts().date;
  let from = url.searchParams.get("from") || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from < today) from = today;
  const maxStart = addDays(today, ADMIN_DAYS_AHEAD - 14);
  if (from > maxStart) from = maxStart;
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "14", 10) || 14, 1), 31);
  const end = addDays(from, days - 1);
  const closed = await env.DB.prepare(
    "SELECT date, time FROM closed_slots WHERE date BETWEEN ?1 AND ?2 ORDER BY date, time"
  ).bind(from, end).all();
  const booked = await env.DB.prepare(
    `SELECT s.date, s.time, r.id AS res_id, r.name AS res_name, r.status AS res_status
     FROM slots s
     JOIN reservations r ON r.slot_id = s.id AND r.status IN ${ACTIVE}
     WHERE s.date BETWEEN ?1 AND ?2
     ORDER BY s.date, s.time`
  ).bind(from, end).all();
  return json({ ok: true, today, from, end, grid: GRID_TIMES, closed: closed.results, booked: booked.results });
}

/* ── 관리자: 슬롯 열기/닫기 (일괄) ── */
async function adminToggleSlots(req, env) {
  const b = await readJson(req);
  const today = kstParts().date;
  const date = String(b.date || "");
  const open = b.open === true;
  const times = Array.isArray(b.times) ? b.times.slice(0, 48) : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > addDays(today, ADMIN_DAYS_AHEAD - 1))
    throw new ApiError(400, "bad_date", "오늘부터 8주 이내 날짜만 관리할 수 있어요.");
  if (!times.length || times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    throw new ApiError(400, "bad_times", "시간 형식이 올바르지 않아요.");

  const ph = times.map((_, i) => `?${i + 2}`).join(",");
  if (open) {
    // 열기 = 닫힘 블록리스트에서 제거 (기본이 열림)
    await env.DB.prepare(
      `DELETE FROM closed_slots WHERE date = ?1 AND time IN (${ph})`
    ).bind(date, ...times).run();
    return json({ ok: true, opened: times.length });
  }
  // 닫기 = 블록리스트에 추가. 활성 예약이 잡힌 칸은 건너뛰고 개수 보고
  const lockedRows = await env.DB.prepare(
    `SELECT s.time FROM slots s
     JOIN reservations r ON r.slot_id = s.id AND r.status IN ${ACTIVE}
     WHERE s.date = ?1 AND s.time IN (${ph})`
  ).bind(date, ...times).all();
  const lockedSet = new Set(lockedRows.results.map((x) => x.time));
  const toClose = times.filter((t) => !lockedSet.has(t));
  if (toClose.length) {
    await env.DB.batch(toClose.map((t) =>
      env.DB.prepare("INSERT OR IGNORE INTO closed_slots (date, time) VALUES (?1, ?2)").bind(date, t)
    ));
  }
  return json({ ok: true, closed: toClose.length, locked: lockedSet.size });
}

/* ── 관리자: 통계 (예약 현황 + 퍼널) ── */
async function adminStats(env) {
  const today = kstParts().date;
  const weekAgo = addDays(today, -6);
  const funnel = async (from) => {
    const rs = await env.DB.prepare(
      "SELECT name, COUNT(*) AS c FROM events WHERE date >= ?1 GROUP BY name"
    ).bind(from).all();
    return Object.fromEntries(rs.results.map((r) => [r.name, r.c]));
  };
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM reservations WHERE status = 'pending'").first();
  const upcoming = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM reservations r JOIN slots s ON s.id = r.slot_id
     WHERE r.status = 'approved' AND s.date >= ?1`
  ).bind(today).first();
  const week = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM reservations WHERE created_at >= datetime('now', '-7 days')"
  ).first();
  // 유입 경로별 방문·신청 (9단계 — 구버전 이벤트는 direct로 집계)
  const sources = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(source, ''), 'direct') AS src,
            SUM(CASE WHEN name = 'page_view' THEN 1 ELSE 0 END) AS visits,
            SUM(CASE WHEN name = 'booking_submit' THEN 1 ELSE 0 END) AS bookings
     FROM events WHERE date >= ?1
     GROUP BY src ORDER BY visits DESC LIMIT 8`
  ).bind(weekAgo).all();
  return json({
    ok: true, today,
    reservations: { pending: pending.c, upcoming: upcoming.c, week: week.c },
    funnelToday: await funnel(today),
    funnelWeek: await funnel(weekAgo),
    sourcesWeek: sources.results,
  });
}

/* ══════════ 텔레그램 담당배정봇 ══════════
   흐름: 새 신청 → 타로사 그룹에 알림 + [🙋 담당하기] 버튼 → 먼저 누른 타로사가 담당(선착순)
   승인/취소는 기존대로 관리자탭 — 결과는 그룹에 자동 공유
   ※ 고객 전화번호는 그룹에 올리지 않는다 (개인정보) */

function koDT(date, time) {
  const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${date}T12:00:00+09:00`).getUTCDay()];
  const p = date.split("-");
  return `${Number(p[1])}/${Number(p[2])}(${dow}) ${time}`;
}
async function tgCall(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ ok: false }));
}

/* 새 신청 → 그룹 알림 + 담당하기 버튼 */
async function notifyTelegram(env, r) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const chatId = await getSetting(env, "tg_chat_id");
    if (!chatId) return;
    const text =
      `🔔 새 예약 신청 #${r.id}\n` +
      `📅 ${koDT(r.date, r.time)} · 30분 리딩\n` +
      `👤 ${r.name}` +
      (r.category ? `\n${CAT_KO[r.category] || ""}` : "") +
      (r.note ? `\n💬 ${r.note}` : "") +
      `\n\n담당하실 분은 아래 버튼을 눌러주세요 👇`;
    const res = await tgCall(env, "sendMessage", {
      chat_id: chatId, text,
      reply_markup: { inline_keyboard: [[{ text: "🙋 담당하기", callback_data: `claim:${r.id}` }]] },
    });
    if (res.ok && res.result) {
      await env.DB.prepare("UPDATE reservations SET tg_msg_id = ?1 WHERE id = ?2")
        .bind(String(res.result.message_id), r.id).run();
    }
  } catch (e) { console.error("notifyTelegram fail:", e); }
}

/* 승인/취소 → 그룹에 상태 공유 (원 알림에 답글) */
async function tgStatusPost(env, r) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const chatId = await getSetting(env, "tg_chat_id");
    if (!chatId) return;
    const head = r.status === "approved" ? "✅ 확정 완료" : "❌ 취소됨";
    const text = `${head} — ${r.name}님 · ${koDT(r.date, r.time)}` +
      (r.assignee_name ? `\n🙋 담당: ${r.assignee_name}` : "");
    const payload = { chat_id: chatId, text };
    if (r.tg_msg_id) payload.reply_to_message_id = Number(r.tg_msg_id);
    const res = await tgCall(env, "sendMessage", payload);
    if (!res.ok && r.tg_msg_id) await tgCall(env, "sendMessage", { chat_id: chatId, text }); // 원 메시지 삭제됐으면 답글 없이
  } catch (e) { console.error("tgStatusPost fail:", e); }
}

/* 웹훅: [담당하기] 버튼 콜백 — 선착순 배정 */
async function tgWebhook(req, env) {
  const secret = await getSetting(env, "tg_webhook_secret");
  if (!secret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret)
    throw new ApiError(403, "forbidden", "인증 실패");
  const update = await readJson(req);
  const cb = update.callback_query;
  if (cb && cb.data && cb.data.startsWith("claim:") && cb.from) {
    const id = Number(cb.data.slice(6));
    const who = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ") || cb.from.username || "타로사";
    const upd = await env.DB.prepare(
      `UPDATE reservations SET assignee_name = ?1, assignee_tg = ?2, updated_at = datetime('now')
       WHERE id = ?3 AND assignee_name IS NULL AND status != 'cancelled'`
    ).bind(who, String(cb.from.id), id).run();
    if (upd.meta.changes > 0) {
      await tgCall(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `${who}님이 담당하게 됐어요 🌙` });
      if (cb.message) {
        await tgCall(env, "editMessageText", {
          chat_id: cb.message.chat.id, message_id: cb.message.message_id,
          text: `${cb.message.text}\n\n🙋 담당: ${who}`,
        });
      }
    } else {
      const row = await env.DB.prepare("SELECT assignee_name, status FROM reservations WHERE id = ?1").bind(id).first();
      const msg = !row ? "없는 예약이에요"
        : row.status === "cancelled" ? "취소된 예약이에요"
        : row.assignee_name ? `이미 ${row.assignee_name}님 담당이에요`
        : "처리할 수 없어요";
      await tgCall(env, "answerCallbackQuery", { callback_query_id: cb.id, text: msg, show_alert: true });
    }
  }
  return json({ ok: true });
}

/* 관리자: 봇 연결 상태 */
async function tgStatus(env) {
  const chatId = await getSetting(env, "tg_chat_id");
  const title = chatId ? await getSetting(env, "tg_chat_title") : null;
  return json({ ok: true, configured: !!env.TELEGRAM_BOT_TOKEN, connected: !!chatId, chat_title: title || "" });
}

/* 관리자: 봇-그룹 연결 (봇을 그룹에 초대 + 아무 메시지 1개 → 이 버튼) */
async function tgSetup(env, url) {
  if (!env.TELEGRAM_BOT_TOKEN)
    throw new ApiError(503, "setup_required", "TELEGRAM_BOT_TOKEN 시크릿을 먼저 설정해 주세요. (Cloudflare → myoyeon → Settings → Variables and Secrets)");
  await tgCall(env, "deleteWebhook", {}); // getUpdates를 쓰기 위해 잠시 해제
  const updates = await tgCall(env, "getUpdates", { limit: 100, allowed_updates: ["message", "my_chat_member"] });
  if (!updates.ok)
    throw new ApiError(502, "tg_error", `텔레그램 응답 오류: ${updates.description || "알 수 없음"} — TELEGRAM_BOT_TOKEN 값이 BotFather가 준 토큰 그대로인지 확인해 주세요.`);
  let chat = null;
  if (Array.isArray(updates.result)) {
    for (const u of updates.result.reverse()) {
      const c = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
      if (c && (c.type === "group" || c.type === "supergroup")) { chat = c; break; }
    }
  }
  if (!chat)
    throw new ApiError(404, "no_group", "그룹 메시지를 아직 못 받았어요. 그룹 채팅창에 /start 를 보낸 뒤 다시 눌러주세요. (봇 프라이버시 모드 때문에 일반 메시지는 봇에게 안 보일 수 있어요 — /로 시작하는 명령어는 항상 전달돼요)");
  const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await setSetting(env, "tg_chat_id", String(chat.id));
  await setSetting(env, "tg_chat_title", chat.title || "");
  await setSetting(env, "tg_webhook_secret", secret);
  const hook = await tgCall(env, "setWebhook", {
    url: `${url.origin}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["callback_query"],
  });
  if (!hook.ok) throw new ApiError(502, "webhook_fail", "웹훅 등록 실패: " + (hook.description || "알 수 없는 오류"));
  await tgCall(env, "sendMessage", { chat_id: chat.id, text: "🌙 묘연 예약봇 연결 완료!\n새 예약 신청이 들어오면 여기로 알려드릴게요. [🙋 담당하기]를 먼저 누른 분이 담당이 됩니다." });
  return json({ ok: true, chat_title: chat.title || "" });
}
