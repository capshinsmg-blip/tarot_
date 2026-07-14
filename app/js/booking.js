/* 묘연 · 예약 3스텝 바텀시트 (8단계) — main.js의 DM 스텁(openSheet)을 대체
   플로우: ① 메뉴 확인 → ② 일시 선택 → ③ 정보 입력 → 접수 완료
   API(D1) 미연결·장애 시 기존 인스타 DM 시트(window.openDMSheet)로 자동 폴백 */

(() => {
  const $id = (s) => document.getElementById(s);
  const MENU_LINE = "30분 · 5,000원 · 현장 결제";
  const SHOP_ROAD = "경기도 안산시 단원구 광덕대로 168";
  const SHOP_DETAIL = "신화타운 3층 · 멜로우스페이스";
  // 지도 검색은 도로명까지만 (층·호수는 검색어에 넣으면 결과가 안 나옴)
  const MAP_KAKAO = `https://map.kakao.com/link/search/${encodeURIComponent(SHOP_ROAD)}`;
  const MAP_NAVER = `https://map.naver.com/v5/search/${encodeURIComponent(SHOP_ROAD)}`;
  const CAT_LINE = {
    love: "오늘 뽑은 연애 카드의 이야기, 직접 만나 더 깊이 풀어봐요",
    money: "금전 흐름은 카드 한 장보다 길게 — 공방에서 차분히 짚어드려요",
    work: "일과 성장의 갈림길, 카드 너머의 방향을 함께 찾아봐요",
    overall: "오늘 카드가 건넨 이야기, 공방에서 더 깊이 이어가요",
  };
  const DOW = ["일", "월", "화", "수", "목", "금", "토"];

  let slots = [];                       // [{id,date,time}] 서버 기준 예약 가능 슬롯
  let today = "";
  let sel = { date: null, slotId: null, time: null };
  let dim = null, sheet = null, errTimer = null;

  /* ── 퍼널 로깅: 픽셀 스텁(track) 호출에 얹어 D1에도 적재 ── */
  function logEvent(name) {
    try {
      fetch("/api/event", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source: (window.getSource && window.getSource()) || "" }),
      }).catch(() => {});
    } catch (e) { /* 무시 */ }
  }
  document.addEventListener("DOMContentLoaded", () => {
    logEvent("page_view");
    const orig = window.track;
    if (typeof orig === "function") {
      const MAP = { draw_start: "draw_start", ViewContent: "result_view", InitiateCheckout: "booking_open", Schedule: "booking_submit", share_save: "share_save" };
      window.track = (n, p) => { orig(n, p); if (MAP[n]) logEvent(MAP[n]); };
    }
  });

  /* ── 유틸 ── */
  function savedCat() {
    try {
      const s = JSON.parse(localStorage.getItem("myoyeon_daily_v1"));
      return s && CAT_LINE[s.cat] ? s.cat : "overall";
    } catch (e) { return "overall"; }
  }
  const fmtMD = (d) => { const p = d.split("-"); return `${Number(p[1])}/${Number(p[2])}`; };
  const dowOf = (d) => DOW[new Date(`${d}T12:00:00+09:00`).getDay()];
  const fmtFull = (d, t) => `${fmtMD(d)}(${dowOf(d)}) ${t}`;
  function addDaysStr(dateStr, n) {
    const p = dateStr.split("-").map(Number);
    const dt = new Date(p[0], p[1] - 1, p[2] + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }

  /* ── 시트 열기 ── */
  function openBooking() {
    if (typeof window.track === "function") window.track("InitiateCheckout", { content_name: "tarot_reading" });
    closeSheet();
    sel = { date: null, slotId: null, time: null };

    dim = document.createElement("div");
    dim.id = "sheet-dim";
    sheet = document.createElement("div");
    sheet.id = "sheet";
    sheet.classList.add("bk");
    sheet.innerHTML = `
      <div class="bk-head">
        <button class="bk-back hidden" id="bk-back" aria-label="뒤로">‹</button>
        <h3>1:1 타로리딩 예약</h3>
        <div class="bk-dots" id="bk-dots"><i class="on"></i><i></i><i></i></div>
      </div>

      <div class="bk-step" id="bk-s1">
        <div class="bk-menu">
          <div class="bk-menu-title">🔮 1:1 타로리딩<span>대면</span></div>
          <div class="bk-menu-meta">${MENU_LINE}</div>
          <p class="bk-menu-desc">${CAT_LINE[savedCat()]}</p>
        </div>
        <div class="bk-loc">
          <p class="bk-label">📍 공방 위치 — 오프라인 방문 리딩이에요</p>
          <div class="bk-loccard">
            <div class="bk-loc-road">${SHOP_ROAD}</div>
            <div class="bk-loc-detail">${SHOP_DETAIL}</div>
          </div>
          <div class="bk-mapbtns">
            <a class="bk-navermap" href="${MAP_NAVER}" target="_blank" rel="noopener">네이버지도로 길찾기</a>
            <a class="btn-ghost" href="${MAP_KAKAO}" target="_blank" rel="noopener">카카오맵</a>
          </div>
        </div>
        <button class="btn-primary" id="bk-next1">일시 고르기</button>
      </div>

      <div class="bk-step hidden" id="bk-s2">
        <p class="bk-label">날짜</p>
        <div class="bk-dates" id="bk-dates"></div>
        <p class="bk-label">시간</p>
        <div class="bk-times" id="bk-times"><p class="bk-empty">시간표를 불러오는 중…</p></div>
        <button class="btn-primary" id="bk-next2" disabled>이 시간으로 할게요</button>
      </div>

      <div class="bk-step hidden" id="bk-s3">
        <div class="bk-summary" id="bk-sum3"></div>
        <input class="bk-input" id="bk-name" maxlength="20" placeholder="이름" autocomplete="name">
        <input class="bk-input" id="bk-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="연락처 (010-0000-0000)" autocomplete="tel">
        <input class="bk-input" id="bk-note" maxlength="100" placeholder="궁금한 점 한 줄 (선택)">
        <input class="bk-hp" id="bk-web" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="bk-consent"><input type="checkbox" id="bk-consent"><span>개인정보 수집·이용 동의 <b>(필수)</b></span></label>
        <p class="bk-consent-detail">이름·연락처를 예약 확인과 안내 목적으로만 사용하고, 리딩 완료 6개월 후 파기해요.</p>
        <button class="btn-primary" id="bk-submit">예약 신청하기</button>
      </div>

      <div class="bk-step bk-done hidden" id="bk-s4">
        <div class="bk-check">✓</div>
        <h4>신청이 접수됐어요!</h4>
        <div class="bk-summary" id="bk-sum4"></div>
        <p class="bk-note2">운영자가 확인한 뒤 <b>문자로 확정 안내</b>를 드려요.<br>보통 몇 시간 안에 연락드릴게요 🌙</p>
        <div class="bk-summary" style="width:100%"><b>📍 오시는 길</b><br>${SHOP_ROAD}<br>${SHOP_DETAIL}</div>
        <div class="bk-mapbtns" style="width:100%">
          <a class="bk-navermap" href="${MAP_NAVER}" target="_blank" rel="noopener">네이버지도로 길찾기</a>
          <a class="btn-ghost" href="${MAP_KAKAO}" target="_blank" rel="noopener">카카오맵</a>
        </div>
        <a class="btn-ghost" style="width:100%" href="https://www.instagram.com/myoyeon.tarot" target="_blank" rel="noopener">@myoyeon.tarot 팔로우하기</a>
        <button class="btn-primary" id="bk-done-close" style="width:100%">닫기</button>
      </div>

      <p class="bk-error hidden" id="bk-error"></p>`;

    document.body.append(dim, sheet);
    dim.onclick = closeSheet;
    $id("bk-back").onclick = () => showStep(currentStep() - 1);
    $id("bk-next1").onclick = () => showStep(2);
    $id("bk-next2").onclick = () => { fillSummary(); showStep(3); };
    $id("bk-submit").onclick = submit;
    $id("bk-done-close").onclick = closeSheet;
    $id("bk-phone").addEventListener("input", formatPhone);

    showStep(1);
    loadSlots();
  }
  window.openBooking = openBooking; // main.js의 예약 버튼이 이걸 우선 호출

  function closeSheet() {
    if (dim) dim.remove();
    if (sheet) sheet.remove();
    dim = sheet = null;
  }
  function fallbackDM() {
    closeSheet();
    if (typeof window.openDMSheet === "function") window.openDMSheet();
    else window.open("https://ig.me/m/myoyeon.tarot", "_blank");
  }

  /* ── 스텝 전환 ── */
  const stepIds = ["bk-s1", "bk-s2", "bk-s3", "bk-s4"];
  function currentStep() {
    return stepIds.findIndex((id) => !$id(id).classList.contains("hidden")) + 1;
  }
  function showStep(n) {
    if (!sheet || n < 1) return;
    stepIds.forEach((id, i) => $id(id).classList.toggle("hidden", i !== n - 1));
    $id("bk-back").classList.toggle("hidden", n === 1 || n === 4);
    [...$id("bk-dots").children].forEach((el, i) => el.classList.toggle("on", i < Math.min(n, 3)));
    sheet.scrollTop = 0;
  }
  function showErr(msg) {
    const el = $id("bk-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(errTimer);
    errTimer = setTimeout(() => el && el.classList.add("hidden"), 4000);
  }

  /* ── 슬롯 로드 & 렌더 ── */
  async function loadSlots() {
    try {
      const res = await fetch("/api/slots");
      if (!res.ok) throw new Error("api " + res.status);
      const data = await res.json();
      slots = data.slots || [];
      today = data.today;
      renderDates();
    } catch (e) {
      fallbackDM(); // 백엔드 미연결 → 기존 인스타 DM 안내 (서비스 무중단)
    }
  }
  function renderDates() {
    const wrap = $id("bk-dates");
    if (!wrap) return;
    wrap.innerHTML = "";
    const countByDate = {};
    slots.forEach((s) => { countByDate[s.date] = (countByDate[s.date] || 0) + 1; });

    for (let i = 0; i < 14; i++) {
      const d = addDaysStr(today, i);
      const btn = document.createElement("button");
      btn.className = "bk-date";
      btn.disabled = !countByDate[d];
      btn.innerHTML = `${fmtMD(d)}<small>${i === 0 ? "오늘" : i === 1 ? "내일" : dowOf(d) + "요일"}</small>`;
      btn.onclick = () => {
        sel = { date: d, slotId: null, time: null };
        [...wrap.children].forEach((c) => c.classList.remove("sel"));
        btn.classList.add("sel");
        $id("bk-next2").disabled = true;
        renderTimes(d);
      };
      wrap.appendChild(btn);
    }
    const first = wrap.querySelector(".bk-date:not(:disabled)");
    if (first) first.click();
    else $id("bk-times").innerHTML = `<p class="bk-empty">지금 열려 있는 예약 시간이 없어요 😿<br>인스타 DM으로 문의해 주세요</p>`;
  }
  function renderTimes(date) {
    const wrap = $id("bk-times");
    wrap.innerHTML = "";
    slots.filter((s) => s.date === date).forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "bk-time";
      btn.textContent = s.time;
      btn.onclick = () => {
        sel.slotId = s.id;
        sel.time = s.time;
        [...wrap.children].forEach((c) => c.classList.remove("sel"));
        btn.classList.add("sel");
        $id("bk-next2").disabled = false;
      };
      wrap.appendChild(btn);
    });
  }
  function fillSummary() {
    $id("bk-sum3").innerHTML = `<b>${fmtFull(sel.date, sel.time)}</b> · 1:1 타로리딩 ${MENU_LINE}`;
  }

  /* ── 연락처 자동 하이픈 ── */
  function formatPhone() {
    const el = $id("bk-phone");
    const d = el.value.replace(/\D/g, "").slice(0, 11);
    el.value = d.length > 7 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
             : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
  }

  /* ── 신청 ── */
  async function submit() {
    const name = $id("bk-name").value.trim();
    const phone = $id("bk-phone").value.trim();
    const note = $id("bk-note").value.trim();
    if (!sel.slotId) { showStep(2); return; }
    if (!name) return showErr("이름을 입력해 주세요.");
    if (!/^01[016789]-?\d{3,4}-?\d{4}$/.test(phone.replace(/\s/g, ""))) return showErr("연락처를 확인해 주세요. (예: 010-1234-5678)");
    if (!$id("bk-consent").checked) return showErr("개인정보 수집 동의에 체크해 주세요.");

    const btn = $id("bk-submit");
    btn.disabled = true;
    btn.textContent = "신청 중…";
    try {
      const res = await fetch("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot_id: sel.slotId, name, phone, note,
          category: savedCat(), consent: true,
          source: (window.getSource && window.getSource()) || "", // 유입 경로 (9단계)
          website: $id("bk-web").value, // 허니팟
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        if (typeof window.track === "function") window.track("Schedule", { content_name: "tarot_reading" });
        $id("bk-sum4").innerHTML =
          `<b>${fmtFull(data.date, data.time)}</b><br>${data.name}님 · 1:1 타로리딩 ${MENU_LINE}`;
        showStep(4);
      } else if (res.status === 409) {
        showErr(data.message || "그 시간이 방금 마감됐어요. 다른 시간을 골라주세요.");
        await loadSlots();
        showStep(2);
      } else if (res.status === 503) {
        fallbackDM();
      } else {
        showErr(data.message || "잠시 후 다시 시도해 주세요.");
      }
    } catch (e) {
      showErr("연결이 불안정해요. 잠시 후 다시 시도해 주세요.");
    } finally {
      btn.disabled = false;
      btn.textContent = "예약 신청하기";
    }
  }
})();
