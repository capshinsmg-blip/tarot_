/* 묘연 · 예약 백엔드 (Cloudflare Worker + D1)
   라우팅: 정적 에셋(app/)이 먼저 매치되고, 남는 요청(/api/*)이 여기로 온다.
   D1 미연결(env.DB 없음) 시 모든 API가 503 → 프론트는 인스타 DM 안내로 폴백.
   스키마는 첫 요청 시 자동 생성 (worker/schema.sql은 참고용) */

const ACTIVE = "('pending','approved')"; // 슬롯을 점유하는 예약 상태
const EVENT_NAMES = new Set(["page_view", "draw_start", "result_view", "booking_open", "booking_submit", "share_save"]);
const CATEGORIES = new Set(["love", "money", "work", "overall"]);
const BOOK_LEAD_MIN = 60;        // 슬롯 시작 60분 전까지만 신청 가능
const MAX_ACTIVE_PER_PHONE = 2;  // 전화번호당 활성 예약 상한 (스팸 방지)
const DAYS_AHEAD = 14;           // 노출/관리 기간
const COOKIE = "myo_admin";

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

  // ── 관리자 API ──
  if (path === "/api/admin/login" && method === "POST") return adminLogin(req, env, url);
  if (path.startsWith("/api/admin/")) {
    if (!(await isAdmin(req, env))) throw new ApiError(401, "unauthorized", "로그인이 필요해요.");
    if (path === "/api/admin/logout" && method === "POST") return adminLogout(url);
    if (path === "/api/admin/me" && method === "GET") return json({ ok: true });
    if (path === "/api/admin/reservations" && method === "GET") return adminListReservations(env, url);
    const m = path.match(/^\/api\/admin\/reservations\/(\d+)$/);
    if (m && method === "POST") return adminUpdateReservation(req, env, Number(m[1]));
    if (path === "/api/admin/slots" && method === "GET") return adminListSlots(env);
    if (path === "/api/admin/slots" && method === "POST") return adminToggleSlots(req, env);
    if (path === "/api/admin/stats" && method === "GET") return adminStats(env);
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
  ]);
  schemaReady = true;
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

/* ── 공개: 퍼널 이벤트 ── */
async function apiEvent(req, env) {
  const b = await readJson(req);
  if (!EVENT_NAMES.has(b.name)) return json({ ok: false });
  await env.DB.prepare("INSERT INTO events (name, date) VALUES (?1, ?2)").bind(b.name, kstParts().date).run();
  return json({ ok: true });
}

/* ── 공개: 예약 가능 슬롯 ── */
async function apiSlots(env) {
  const today = kstParts().date;
  const end = addDays(today, DAYS_AHEAD - 1);
  const rs = await env.DB.prepare(
    `SELECT s.id, s.date, s.time FROM slots s
     WHERE s.date BETWEEN ?1 AND ?2
       AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id AND r.status IN ${ACTIVE})
     ORDER BY s.date, s.time`
  ).bind(today, end).all();
  const minEpoch = Date.now() + BOOK_LEAD_MIN * 60000;
  const slots = rs.results.filter((s) => slotEpoch(s.date, s.time) >= minEpoch);
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
  const slotId = Number(b.slot_id);

  if (!name || name.length > 20) throw new ApiError(400, "bad_name", "이름을 1~20자로 입력해 주세요.");
  if (!phone) throw new ApiError(400, "bad_phone", "연락처를 확인해 주세요. (예: 010-1234-5678)");
  if (b.consent !== true) throw new ApiError(400, "consent_required", "개인정보 수집 동의가 필요해요.");
  if (!Number.isInteger(slotId) || slotId <= 0) throw new ApiError(400, "bad_slot", "예약 시간을 선택해 주세요.");

  const slot = await env.DB.prepare("SELECT id, date, time FROM slots WHERE id = ?1").bind(slotId).first();
  if (!slot) throw new ApiError(409, "slot_gone", "그 시간이 방금 마감됐어요. 다른 시간을 골라주세요.");
  if (slotEpoch(slot.date, slot.time) < Date.now() + BOOK_LEAD_MIN * 60000)
    throw new ApiError(409, "slot_closed", "그 시간은 신청이 마감됐어요. 다른 시간을 골라주세요.");

  const today = kstParts().date;
  const dup = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM reservations r JOIN slots s ON s.id = r.slot_id
     WHERE r.phone = ?1 AND r.status IN ${ACTIVE} AND s.date >= ?2`
  ).bind(phone, today).first();
  if (dup.c >= MAX_ACTIVE_PER_PHONE)
    throw new ApiError(409, "too_many", "확인 대기 중인 예약이 이미 있어요. 확정 안내 후 다시 신청해 주세요.");

  let id;
  try {
    const r = await env.DB.prepare(
      "INSERT INTO reservations (slot_id, name, phone, note, category) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(slotId, name, phone, note, category).run();
    id = r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "slot_taken", "아쉽지만 방금 다른 분이 그 시간을 신청했어요. 다른 시간을 골라주세요.");
    throw e;
  }

  ctx.waitUntil(notifyAdmin(env, { name, phone, note, date: slot.date, time: slot.time }));
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
  const base = `SELECT r.id, r.name, r.phone, r.note, r.category, r.status, r.created_at, s.date, s.time
                FROM reservations r JOIN slots s ON s.id = r.slot_id`;
  let q;
  if (scope === "pending") q = env.DB.prepare(`${base} WHERE r.status = 'pending' ORDER BY s.date, s.time`);
  else if (scope === "upcoming") q = env.DB.prepare(`${base} WHERE r.status = 'approved' AND s.date >= ?1 ORDER BY s.date, s.time`).bind(today);
  else q = env.DB.prepare(`${base} ORDER BY r.created_at DESC LIMIT 300`);
  const rs = await q.all();
  return json({ ok: true, today, reservations: rs.results });
}

/* ── 관리자: 승인/취소 ── */
async function adminUpdateReservation(req, env, id) {
  const b = await readJson(req);
  const action = b.action;
  if (!["approve", "cancel"].includes(action)) throw new ApiError(400, "bad_action", "approve 또는 cancel만 가능해요.");
  const row = await env.DB.prepare(
    `SELECT r.id, r.status, r.name, r.phone, s.date, s.time
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
  return json({ ok: true, id, status, name: row.name, phone: row.phone, date: row.date, time: row.time });
}

/* ── 관리자: 슬롯 그리드 조회 (예약 점유 정보 포함) ── */
async function adminListSlots(env) {
  const today = kstParts().date;
  const end = addDays(today, DAYS_AHEAD - 1);
  const rs = await env.DB.prepare(
    `SELECT s.id, s.date, s.time, r.id AS res_id, r.name AS res_name, r.status AS res_status
     FROM slots s
     LEFT JOIN reservations r ON r.slot_id = s.id AND r.status IN ${ACTIVE}
     WHERE s.date BETWEEN ?1 AND ?2
     ORDER BY s.date, s.time`
  ).bind(today, end).all();
  return json({ ok: true, today, end, slots: rs.results });
}

/* ── 관리자: 슬롯 열기/닫기 (일괄) ── */
async function adminToggleSlots(req, env) {
  const b = await readJson(req);
  const today = kstParts().date;
  const date = String(b.date || "");
  const open = b.open === true;
  const times = Array.isArray(b.times) ? b.times.slice(0, 48) : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > addDays(today, 27))
    throw new ApiError(400, "bad_date", "오늘부터 4주 이내 날짜만 관리할 수 있어요.");
  if (!times.length || times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    throw new ApiError(400, "bad_times", "시간 형식이 올바르지 않아요.");

  if (open) {
    await env.DB.batch(times.map((t) =>
      env.DB.prepare("INSERT OR IGNORE INTO slots (date, time) VALUES (?1, ?2)").bind(date, t)
    ));
    return json({ ok: true, opened: times.length });
  }
  // 닫기: 활성 예약이 잡힌 슬롯은 보호
  const ph = times.map((_, i) => `?${i + 2}`).join(",");
  const locked = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM slots s
     JOIN reservations r ON r.slot_id = s.id AND r.status IN ${ACTIVE}
     WHERE s.date = ?1 AND s.time IN (${ph})`
  ).bind(date, ...times).first();
  await env.DB.prepare(
    `DELETE FROM slots WHERE date = ?1 AND time IN (${ph})
     AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = slots.id AND r.status IN ${ACTIVE})`
  ).bind(date, ...times).run();
  return json({ ok: true, locked: locked.c });
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
  return json({
    ok: true, today,
    reservations: { pending: pending.c, upcoming: upcoming.c, week: week.c },
    funnelToday: await funnel(today),
    funnelWeek: await funnel(weekAgo),
  });
}
