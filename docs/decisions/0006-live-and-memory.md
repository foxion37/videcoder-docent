# 0006 — 라이브 따라가기 + 질문 기억, Jev 는 판정 전용

Date: 2026-09-21
Status: Accepted

## Context

지금 웹앱은 "지난 세션 골라서 묻기"다. 사용자가 원하는 건 (1) 지금 돌아가는 세션을 옆에서 따라가며 새 메시지·에러·선택지가 뜨면 앞뒤 맥락을 찾아 설명, (2) 선택지가 주어지면 각 선택지 뜻과 부수효과, (3) 질문을 저장·기억, (4) 용어집, (5) 자주 묻는 것 통계, (6) 미리 알려주기. 두 줄기(라이브 1→2→6, 기억 3→4→5→6)의 바닥인 1과 3을 함께 만든다.

Jev(TypeSafe System One)는 텍스트를 생성하지 않고 상태에 대한 typed 질문(choice/score/noul)에 확률로 답한다. 한 요청에 질문 여러 개, 수백 ms.

## Decision

### 역할 분담
- **Jev = 판정.** 라이브 이벤트마다 "알려줄 만한가(noul)", "종류(choice: error / question / done / blocked / progress)"를 묻는다. 사용자 질문의 유형 분류(통계용)도 Jev.
- **omp 도슨트 = 설명.** 본문은 계속 `prompt/docent.md` 로 omp headless.
- Jev 키는 `TYPESAFE_API_KEY` 환경변수로만. 파일에 쓰지 않는다. 키가 없으면 `app/jev.mjs` 가 `null` 을 돌려주고 규칙 기반(에러 결과 / ask·AskUserQuestion 호출 / 긴 어시스턴트 텍스트)으로 대체한다. 기능은 줄지만 죽지 않는다.

### 라이브 (1, 2)
- `GET /api/live?id=` — SSE. 서버가 세션 파일을 1초마다 stat 해 새 줄만 읽고, 제공자별 `events(entries)` 로 이벤트를 뽑는다: `user`(사용자 발화), `assistant`(에이전트 텍스트), `error`(도구 실패), `question`(ask / AskUserQuestion 호출: 질문·선택지 포함), `done`(세션 종료 표시).
- `assistant` 는 Jev 로 걸러 "알려줄 만한" 것만 보낸다. `error`·`question` 은 항상.
- UI 는 세션을 고르면 자동 구독. 이벤트는 작은 알림 카드로 쌓이고, 카드의 버튼을 누르면 그 이벤트를 인용한 질문이 도슨트에게 간다("방금 이 에러 뭐야: …"). 앞뒤 맥락은 도슨트가 전사에서 인용문을 찾아(grep) 읽는다. 전사 전체를 매번 다시 정규화한다.
- 가장 최근에 바뀐 세션이 목록 맨 위. 10분 안에 바뀌었으면 "지금" 표시.
- 코어 프롬프트에 6번째 유형 **"이 선택지 뭐야?"** 추가: 선택지마다 뜻 한 줄 + 고르면 따라오는 것. 추천은 사용자가 물을 때만.

### 기억 (3, 4·5 의 바닥)
- `data/questions.jsonl` (gitignore) 에 한 줄씩: `{ts, sessionId, provider, project, question, kind, answer(raw+슬롯)}`.
- `GET /api/history?id=` — 세션을 열면 이전 문답이 먼저 그려진다. `GET /api/history` 전체.
- 용어집·FAQ 는 이 파일 위의 집계라 이번엔 만들지 않는다. 답 안의 `용어(풀이)` 패턴과 `kind` 필드가 재료.

### 안 하는 것
- 파일 감시에 fs.watch 대신 폴링. 단순하고 macOS 에서 확실.
- 라이브 이벤트를 도슨트가 자동으로 설명하지 않는다. 사용자가 카드를 눌러야 한다(질문당 30초, 비용). 6번 "미리 알려주기"는 여기서 시작하되 이번 범위 밖.

## Consequences

- (+) 지금 세션을 열어 두면 에러·선택지가 뜨는 순간 카드가 뜨고, 한 번 눌러 설명을 받는다.
- (+) 문답이 남아서 용어집·FAQ·선제 안내가 집계만으로 가능해진다.
- (−) Jev 없이는 어시스턴트 텍스트 알림이 거칠다(길이 기준).
- (−) 세션당 SSE 연결 하나, 1초 폴링. 세션 파일이 57MB 여도 새 바이트만 읽으므로 괜찮다.
- 영향 범위: `app/live.mjs`, `app/jev.mjs`, `app/store.mjs`, `app/server.mjs`, `app/index.html`, `scripts/transcript-*.mjs`(events 추출), `prompt/docent.md`, `docs/architecture.md`
