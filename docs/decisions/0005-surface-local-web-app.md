# 0005 — 결과물 형태: 로컬 웹앱, 모델 호출은 omp headless

Date: 2026-09-21
Status: Accepted. ADR 0002 §4 "런타임 코드 없음"을 대체한다.

## Context

ADR 0004 까지는 "어떻게 답하나"만 정했고 "사용자가 어디서 묻고 보나"가 없었다. 현재 방식(메인 에이전트가 `task` 로 스폰, 답을 릴레이)은 배관이지 표면이 아니다. 질문할 때마다 메인 에이전트를 멈춰야 하고, 답이 터미널 스크롤에 묻히고, "이렇게 말하면 돼요"를 손으로 복사해야 한다.

후보: A 메인 에이전트 안(현재) / B 사이드카 터미널 창 / C 로컬 웹앱 / D 메신저(Hermes·Telegram).

## Decision

1. **C. 로컬 웹앱.** `node app/server.mjs` → `http://127.0.0.1:4747`. 왼쪽 세션 목록, 오른쪽 채팅. 4슬롯 답을 카드로 렌더하고 "이렇게 말하면 돼요"는 누르면 복사되는 버튼.
2. **모델 호출은 설치된 omp 를 headless 로.** `omp -p --no-session --no-title --tools read,grep,glob --system-prompt prompt/docent.md "전사: … 질문: …"`. API 키를 다루지 않고, `prompt/docent.md` 가 그대로 시스템 프롬프트라 설치 단계도 없다. headless 출력은 평문이라 `{"answer"}` 껍데기 문제도 없다.
3. **의존성 0, 빌드 없음.** Node 내장 `http` + 정적 HTML 한 장. 세션 제공자(`providers`)는 배열이라 Claude Code 세션 폴더는 항목 하나 추가로 붙는다.
4. **슬롯 파싱은 서버가 한 번.** `app/slots.mjs` 가 ADR 0004 헤딩으로 나눈다. 다른 표면(D)이 생기면 같은 파서를 쓴다.
5. A 는 검증·배관용으로 유지. B 는 만들지 않는다. D 는 C 위에 얹는다.

## Consequences

- (+) 비개발자가 브라우저만 열면 됨. 상태 이모지·슬롯이 제대로 보이고, 복사 버튼이 "말하면 돼요"를 실제 행동으로 만든다.
- (+) 호스트 독립이 자연스럽다. 전사 폴더만 알면 omp/Claude Code 세션이 한 목록에 뜬다.
- (−) omp 가 설치돼 있어야 한다. omp 없는 사용자는 지원하지 않는다.
- (−) 질문 하나에 ~30초(전사 60KB 읽기 포함). 동시 질문은 직렬.
- (−) 127.0.0.1 전용. 인증 없음. 다른 기기에서 열지 않는다.
- 영향 범위: `app/`, `package.json`, `scripts/transcript-omp.mjs`(모듈화), `docs/architecture.md`, `README.md`, `AGENTS.md`
