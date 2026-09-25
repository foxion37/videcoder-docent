# AGENTS.md - videcoder-docent

## 프로젝트 핵심

- 바이브코더가 웹앱과 PiP에서 작업 기록을 이해하고 복습하는 설명 전용 도슨트. 서브에이전트 어댑터는 배관·평가용.
- 도슨트는 설명만 한다. 코드 수정·커밋·실행은 하지 않는다.
- 답변 언어는 쉬운 한국어. 용어를 쓰면 한 줄로 풀어 쓴다.

## 구조 규칙

- 코어 프롬프트는 `prompt/docent.md` 하나. 호스트·도구·경로 이름을 쓰지 않는다.
- 어댑터(`adapters/<host>/`)는 프론트매터와 설치 방법만. 프롬프트 본문을 복사하지 않는다.
- 런타임 코드는 `bin/`(CLI), `app/`(웹앱), `scripts/`뿐. 설명 표시에는 Streamdown·React와 로컬 빌드를 사용한다. 자산은 패키지에 포함하고 실행 중 CDN은 사용하지 않는다 (ADR 0015).
- 새 결정은 `docs/decisions/NNNN-*.md` 로 남긴다. 문서 안에서 결정을 번복하지 않는다.
- 코어를 고치면 `scripts/install-omp.sh` 를 다시 실행한다.
- 학습 기억은 사용자·개념·범위를 구분한다. EASY/NORMAL/HARD는 선호이며 능력 등급이 아니다. 근거·저장·PiP 계약은 ADR 0014를 따른다.
- 화면(CSS, 레이아웃, 여백, 버튼 배치)을 고치면 글자, 여백, 정렬을 검사한다. 관리자 기기에서는 `~/SERVICES/docent/jev-env npm run check:design`으로 Jev 판정까지 통과시킨다(키 위치와 기기별 주의는 `~/SERVICES/docent/README.md`). 그 밖의 환경에서는 `TYPESAFE_API_KEY`를 환경변수로만 넣는다. "Jev로 검사했다"는 키를 넣은 실행 결과일 때만 말한다. 화면 문구에 가운데 점과 엠 대시를 쓰지 않는다.

## 운영 원칙

- `AGENTS.md` 는 300줄 미만. 상세 규칙은 문서로 분리.
- 비밀값은 파일에 쓰지 않는다.
- 공개 저장소 `origin`(foxion37/videcoder-docent) 의 `main` 이 정본이다. 변경은 CHANGELOG·버전 갱신 → noreply 작성자로 커밋 → `main` 푸시 → `v<버전>` 태그 푸시 순서. 태그가 GitHub Release tgz 를 만든다. `archive` 원격(옛 비공개 히스토리)에는 푸시하지 않는다.

## 빠른 링크

- @CONTEXT.md
- @docs/concept.md
- @docs/scope.md
- @docs/architecture.md
- @docs/open-questions.md
- @docs/decisions/0001-docs-first.md
- @docs/decisions/0002-host-agnostic-core-omp-first.md
- @prompt/docent.md
- @adapters/omp/README.md
- @docs/decisions/0003-eval-transcripts-and-normalizer.md
- @docs/decisions/0004-answer-format.md
- @docs/decisions/0005-surface-local-web-app.md
- @docs/decisions/0006-live-and-memory.md
- @docs/decisions/0007-distribution.md
- @docs/decisions/0008-glossary-and-faq.md
- @docs/decisions/0009-long-transcripts.md
- @docs/decisions/0010-proactive-hints.md
- @docs/decisions/0011-peers-over-tailscale.md
- @docs/decisions/0012-refresh-and-replay.md
- @docs/decisions/0013-claude-subagent-transcripts.md
- @docs/decisions/0014-learning-evidence-and-pip.md
- @docs/decisions/0015-explanation-first-surface.md
- @docs/decisions/0016-docent-model-selection.md
- @docs/decisions/0028-isolated-runner-and-live-threads.md
- @docs/decisions/0029-ask-jobs-stop-steer-queue.md
- @docs/decisions/0030-light-learning-classification.md
- @docs/decisions/0031-server-side-pre-explanation.md
- @docs/decisions/0032-classify-after-answer-and-more-hosts.md
- @docs/decisions/0033-card-output-as-first-message.md
