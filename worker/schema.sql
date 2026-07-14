-- 묘연 예약 D1 스키마 (참고용 — 실제로는 worker/index.js가 첫 요청 시 자동 생성)

-- 열린 슬롯: 행이 존재하면 예약 가능 시간
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,              -- YYYY-MM-DD (KST)
  time TEXT NOT NULL,              -- HH:MM (30분 간격)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, time)
);

-- 예약: pending(신청) → approved(확정) | cancelled(취소/거절)
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,             -- 010-0000-0000 정규화 저장
  note TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 더블부킹 원천 차단: 활성(pending/approved) 예약은 슬롯당 1건만
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_slot
  ON reservations(slot_id) WHERE status IN ('pending','approved');

-- 퍼널 이벤트 로그 (A4 통계)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,              -- page_view | draw_start | result_view | booking_open | booking_submit | share_save
  date TEXT NOT NULL,              -- YYYY-MM-DD (KST)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_events_date ON events(date, name);
