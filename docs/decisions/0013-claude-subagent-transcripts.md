# 0013 — Claude Code 서브에이전트 전사를 본 전사 안에 접어 넣는다

Date: 2026-09-22
Status: Accepted. `docs/open-questions.md` 4번을 닫는다.

## Context

Claude Code 는 서브에이전트(`Agent` 도구, `Workflow` 도구가 띄우는 것)의 대화를 본 세션 파일에 넣지 않는다. 2.1.x 기준 `<project>/<sessionId>/subagents/**/agent-<id>.jsonl` 에 따로 쓰고, 옆의 `agent-<id>.meta.json` 에 `{agentType, description, toolUseId, model}` 을 남긴다. 본 세션에는 `→ Agent(설명) ⇒ ok · 6줄` 한 줄과, 나중에 오는 `<task-notification>`(성공/실패 요약)뿐이다. 그래서 "그 에이전트가 왜 실패했어?", "왜 그렇게 만들었어?" 의 근거가 도슨트에게 안 보였다. 옛 형식(본 파일 안 `isSidechain: true` 줄)은 확인한 기기들에 남아 있지 않다.

후보: A 계속 뺀다 / B 별도 세션으로 목록에 올린다(맥락이 끊기고 목록이 14개씩 불어난다) / C 본 전사 안, 띄운 자리에 접어 넣는다.

## Decision

1. **C.** `readClaudeSubagents(sessionPath)` 가 옆 폴더를 재귀로 읽고, `normalizeClaudeSession(jsonl, source, subagents)` 가 접어 넣는다. 서버의 claude 제공자와 CLI 둘 다 이 경로.
2. **놓는 자리.** `meta.toolUseId` 가 본 전사의 `Agent` 호출과 맞으면 그 호출 줄 바로 아래. 안 맞으면(워크플로 서브에이전트는 `toolUseId` 가 없다) 서브에이전트 첫 줄의 시각을 보고, 본 전사에서 그 시각 이후 첫 항목 앞에 끼운다. 시간순 텍스트라는 코어의 가정을 지킨다.
3. **모양.** 헤딩 없이 `  │ ` 로 들여 쓴 블록. 첫 줄 `서브에이전트 <type>(<model>) 「<설명>」 이 한 일:`, 그 다음 `(지시) …`(300자), 발화(각 400자), 도구 줄(본 전사와 같은 형식, 에러는 앞 8줄). 헤딩이 없어서 `trim.mjs` 의 `## user` 턴 나누기와 라이브 이벤트 추출에 영향이 없다.
4. **상한.** 블록 하나 8,000자. 넘치면 앞 3,000자·뒤 4,000자만 남기고 `…(가운데 N줄 줄임)…`. 뒤를 더 남기는 이유는 마지막 보고와 실패 지점이 끝에 오기 때문이다.
5. 옛 인라인 `isSidechain` 줄은 계속 뺀다. 검증할 데이터가 없다.
6. 라이브(`extractClaudeEvents`)는 본 파일만 본다. 서브에이전트 안의 에러는 카드로 뜨지 않는다.

## Consequences

- (+) 서브에이전트 전사에만 남은 실패 원인도 본 전사에서 설명할 수 있다.
- (+) 전사 크기는 서브에이전트 15개 포함 49KB → 62KB. 상한 덕에 최악도 서브에이전트당 8KB.
- (−) 원격(peers) 세션은 그쪽 docent 가 정규화하므로 양쪽 버전이 같아야 한다(ADR 0011 과 같은 제약).
- (−) 옆 폴더를 매 요청 다시 읽는다. 3MB·15파일에 수십 ms. 캐시는 필요해지면.
- 영향 범위: `scripts/transcript-claude.mjs`, `app/server.mjs`, `docs/architecture.md`, `docs/open-questions.md`
