# 0003 — 평가 전사 정규화 스크립트는 Node

Date: 2026-09-21
Status: Accepted

## Context

완료 기준에 실제 전사 3개가 필요하다. omp 의 `history://` 는 현재 프로세스에 등록된 에이전트만 보여 주고, 지난 세션 jsonl 은 `read` 로 열면 27MB짜리 JSON 줄이라 도슨트가 읽을 수 없다. `/export` 는 HTML, `/dump` 는 현재 세션 전용.

## Decision

1. 평가에 사용한 개인 전사는 공개 저장소에 포함하지 않는다. `evals/transcripts/` 는 gitignore.
2. `scripts/transcript-omp.mjs` 가 jsonl 을 사람이 읽는 markdown 으로 바꾼다. 사용자·에이전트 발화, 도구 호출 한 줄 요약, 에러 결과 앞 8줄, 압축 지점 표시. 생각(thinking)·정상 도구 결과 본문은 뺀다.
3. 언어는 Node ESM(의존성 0). ADR 0002 §4 의 "정규화가 필요해지는 시점에 언어를 정한다"가 이 시점이다.
4. 이 스크립트가 곧 "전사 정규화" 어댑터 책임의 첫 구현이다. Claude Code 어댑터의 jsonl 변환도 같은 스크립트에 입력 포맷을 추가하는 방식으로 간다.

## Consequences

- (+) 도슨트 코어를 안 바꾸고 지난 세션으로 평가 가능. 전사 1개 ≈ 60KB.
- (+) omp 어댑터가 라이브(`history://`)와 사후(markdown 파일) 두 입력을 모두 지원.
- (−) 전사에 비밀 경로·프로젝트 ID 가 섞여 있어 공유 불가. 공개용 예시가 필요하면 별도 작성.
- (−) 세션 트리의 분기(branch)는 무시하고 파일 순서대로 읽는다. 분기가 있는 세션은 평가에서 제외.
- 영향 범위: `scripts/transcript-omp.mjs`, `evals/`, `.gitignore`, `docs/open-questions.md`
