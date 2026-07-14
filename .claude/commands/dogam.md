---
description: 묘연 타로 도감 캐러셀 7장 생산 (카드 번호 → 슬라이드 HTML → PNG 렌더 → 검수 → 캡션)
argument-hint: <카드 번호 0~21>
---

사용자가 **$ARGUMENTS번 카드**의 도감 캐러셀을 요청했습니다. 아래 파이프라인으로 **7장 PNG + 캡션**을 생산합니다.

## 0. 사전 로드 (생략 금지)

1. `feed/carousel/knowledge/dogam-guide.md` — 구조·디자인 DNA·품질 킬라인 (단일 기준)
2. `feed/carousel/knowledge/banned-words.json` — 금칙어
3. `app/js/cards-data.js` — 해당 카드의 해석·키워드·조언 (텍스트 유일 출처)
4. 기존 완성본 1개 (`feed/carousel/output/00_fool/slides/`) — 레이아웃 기준 복제

## 1. 텍스트 축약

- cards-data.js의 4개 해석(love/money/work/overall)과 keywords/advice에서 가이드 §3 규칙대로 축약
- 도감 본문 슬라이드는 연애/금전/일 3종 (overall은 정의 문장 소재로 활용)
- 금칙어·단정화법 자체 점검

## 2. 슬라이드 HTML 작성

- `feed/carousel/output/<NN_영문명>/slides/slide-01~07.html` (기존 00_fool 슬라이드를 복제 후 텍스트·이미지 경로만 교체)
- 카드 아트: `../../../../../design/cards/major/<파일>.png` (고해상 원본)
- 구조·클래스는 base.css만 사용 — 새 스타일 발명 금지

## 3. 렌더

```bash
node feed/carousel/render.js --card <NN_영문명>
```

## 4. 검수 (킬라인 7항목)

- 생성된 PNG 7장을 **Read로 직접 육안 검수** — 텍스트 잘림·넘침·요소 겹침 확인
- 문제 발견 시 해당 HTML 수정 → `--only N`으로 재렌더

## 5. 캡션 + 마무리

- `output/<카드>/caption.txt` 작성 (가이드 §5 공식)
- 커밋 & push: `update: 도감 <NN> <카드명> 캐러셀 7장`
- 보고: 완성 장수 · 검수 결과 · 발행 안내 (월요일 발행 캘린더 기준)
