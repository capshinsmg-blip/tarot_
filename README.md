# 타로공방 인스타 바이럴 프로젝트

"오늘의 운세 타로카드 뽑기" 랜딩페이지 + 메타 CTA 광고로 타로리딩 예약을 만드는 프로젝트.

## 캠페인 구조 (한 줄 요약)

메타 CTA 광고 → 랜딩페이지(오늘의 운세 뽑기) → ① 타로리딩 예약(주 전환) ② 인스타 팔로우(보조 전환) ③ 스토리 공유(바이럴 루프)

## 라이브 URL

**https://myoyeon.capshinsmg.workers.dev/** — Cloudflare Workers(GitHub 연동), main 브랜치 push마다 자동 재배포

## 진행 로드맵

| 단계 | 내용 | 상태 | 산출물 |
|---|---|---|---|
| 01 | 유저플로우 기획 | ✅ 완료 (2026-07-14) | [planning/01_유저플로우.md](planning/01_유저플로우.md) |
| 02 | 공방 이름 설정 | ✅ 완료 (2026-07-14) — **묘연** | [planning/02_공방이름.md](planning/02_공방이름.md) |
| 03 | 브랜드컬러 설정 | ✅ 완료 (2026-07-14) — **자정의 묘연** | [planning/03_브랜드컬러.md](planning/03_브랜드컬러.md) |
| 04 | 프로필 제작 | ✅ 완료 (2026-07-14) — 이미지·바이오 확정 | [planning/04_프로필.md](planning/04_프로필.md) · [프로필 이미지](design/profile/myoyeon_profile.png) |
| 05 | 메인 캐릭터 선정 | ✅ 완료 (2026-07-14) — **묘연이** | [planning/05_메인캐릭터.md](planning/05_메인캐릭터.md) · [최종 이미지](design/character/myoyeon_main.png) |
| 06 | 타로카드 리디자인 | ✅ 완료 (2026-07-14) — 메이저 22장 + 뒷면 | [planning/06_타로카드.md](planning/06_타로카드.md) · [design/cards/](design/cards/) |
| 07 | 랜딩페이지 제작 | ✅ 완료 (2026-07-14) — 배포 라이브 | [planning/07_랜딩페이지.md](planning/07_랜딩페이지.md) · [app/](app/) · [라이브 사이트](https://myoyeon.capshinsmg.workers.dev/) |
| 08 | 예약체계 + 관리자탭 제작 | ✅ 라이브 가동 (2026-07-14) — 8주 시간표 · 공방 지도 안내 · 텔레그램 담당배정봇 | [planning/08_예약체계.md](planning/08_예약체계.md) · [worker/](worker/) · [app/admin/](app/admin/) |
| 09 | 인스타 ↔ 랜딩 동기화 | ✅ 완료 (2026-07-15) — UTM 유입 추적 + 유입별 통계 (바이오 링크 설정은 사용자 액션) | [planning/09_동기화.md](planning/09_동기화.md) |
| 10 | 피드 컨텐츠 기획 | ✅ 완료 (2026-07-15) — 도감 캐러셀 + 묘연이 릴스 + 데일리 스토리 | [planning/10_피드컨텐츠.md](planning/10_피드컨텐츠.md) |
| 11 | 피드 제작 | 🔶 진행 중 — 도감 캐러셀 **메이저 22장 완성**(각 7슬라이드+캡션) · 릴스/스토리 남음 | [planning/11_피드제작.md](planning/11_피드제작.md) · [feed/carousel/](feed/carousel/) |
| 12 | 메타광고 + 피드 게재 | 🔶 진행 중 — **메타 픽셀 삽입·발화 검증 완료** + CTA 포스터 3비율(1:1·4:5·9:16) 완성 · 광고 집행은 사용자 액션 | [캠페인 세팅 가이드](feed/ads/campaign-setup.md) · [카피·소재 가이드](feed/ads/meta-ad-guide.md) · [feed/ads/](feed/ads/) |

## 폴더 구조

```
tarot/
├── README.md          ← 이 파일 (로드맵 + 진행상황)
├── planning/          ← 단계별 기획 문서 (01~12)
├── design/            ← 브랜드 · 캐릭터 · 카드 원본 (인쇄/피드용 고해상도)
├── app/               ← 랜딩페이지 + /admin 관리자탭 (Workers 정적 에셋)
├── worker/            ← 예약 API (Cloudflare Worker + D1)
└── wrangler.jsonc     ← Workers 배포 설정 (D1 연결 시 주석 해제)
```

## 로컬 실행

```
npx wrangler dev -c wrangler.dev.jsonc --port 8788   # 예약 API 포함 (로컬 D1, 관리자 비번 myoyeon-dev-1234)
npx serve app -l 3300                                # 정적만 (예약은 DM 폴백)
```
