# 구조

```
prompt/docent.md          코어. 호스트 중립 프롬프트. 유일한 진실.
app/server.mjs            로컬 웹앱 서버. 세션 목록·정규화 전사 캐시·HTTP 경로. 설명 요청은 작업(jobs)으로 열어 NDJSON 스트림/JSON으로 응답
app/runner.mjs            omp 실행 정책 한곳: 사용자 전역 설정 격리, 깊이별 thinking, 한 번 호출(-p)과 RPC 대화, 중단·바로잡기 (ADR 0028)
app/conversation.mjs      스레드 = 살아 있는 RPC 대화. 전사는 처음 한 번 + 이후 새 기록만, 닫힌 스레드는 저장된 문답으로 복원 (ADR 0028)
app/jobs.mjs              설명 작업 레지스트리: 대기·분류·설명·완료·실패·중단, 같은 requestId 합류, 스트림 이벤트 (ADR 0029)
app/prefetch.mjs          세션 감시기 공유·미리 설명 예약·사용자 질문 우선 게이트·10분 5개 상한 (ADR 0031)
app/live.mjs              세션 폴링 → 질문·결과·계획만 선별, 재생에도 같은 기준 적용
app/jev.mjs               TypeSafe Jev 의미 판정. 사용 불가 시 구조화 질문만 유지하고 제한 안내
app/store.mjs             learning.json 원자적 저장, 기본 프로필의 기존 questions.jsonl 읽기
app/learning.mjs          프로필·의미 분류 계획(전사 없이)·핵심 단어·설명 모드·학습 상태·관련 기억·요청 상태(시작·완료·실패·중단) (ADR 0014·0030)
app/models.mjs            omp 채팅 모델 카탈로그·단가·정확한 selector 검증 (ADR 0016)
app/evidence.mjs          소스 검증·근거 추출·원문 위치와 주변 맥락 해석 (ADR 0014)
app/review.mjs            답 속 용어 링크용 용어집: 저장된 핵심 단어 + `용어(풀이)` 규칙 추출
app/wiki.mjs              배운 내용 다시보기 용어 사전: 핵심 단어 검증·집계·옛 문답 일괄 추출 (ADR 0020)
app/trim.mjs              긴 전사 줄이기: 120,000자 넘으면 앞 턴은 사용자 발화만, 최근 턴은 그대로 (ADR 0009)
app/peers.mjs             원격 세션 목록·전사·라이브 제공자 (ADR 0011·0014)
app/dialogue.mjs          질문 대상 검증, 서버 발급 스레드 식별자, 사건 카드의 질문 대상·미리 설명 요청문, 분류용 최근 대화 (ADR 0022·0028)
app/slots.mjs             답 → {status, headline, explain, details[]}, Markdown 블록 보존 (ADR 0017)
app/index.html            세션·작업 내용·카드별 대화·즐겨찾기·설정·배운 내용 다시보기·PiP. Streamdown 로컬 자산으로 Markdown 표시 (ADR 0015·0017)
scripts/transcript-omp.mjs    omp 세션 jsonl → 사람이 읽는 전사 (모듈 + CLI)
scripts/transcript-claude.mjs Claude Code 세션 jsonl → 같은 모양의 전사. 옆 폴더의 서브에이전트 전사를 띄운 자리에 접어 넣음 (모듈 + CLI, ADR 0013)
scripts/transcript-codex.mjs  Codex CLI rollout jsonl → 같은 모양의 전사 (모듈 + CLI, ADR 0032)
scripts/transcript-gemini.mjs Gemini CLI 채팅 기록(갱신 연산 접기) → 같은 모양의 전사 (모듈 + CLI, ADR 0032)
scripts/transcript-pi.mjs     pi 세션 → omp 정규화기 재사용, 제목·모델 항목만 변환 (모듈 + CLI, ADR 0032)
scripts/transcript-source.mjs 메시지·내용 버전 기반 소스 표시, 코드와 서브에이전트 원문 보존
scripts/install-omp.sh    프론트매터 + 코어를 결합해 omp 에이전트 파일로 설치
docs/                     개념·범위·결정
```

## 두 경로

| | 웹앱 (ADR 0005, 기본) | 서브에이전트 (ADR 0002, 배관) |
| --- | --- | --- |
| 사용자 | 브라우저에서 직접 | 메인 에이전트에게 부탁 |
| 코어 전달 | `--system-prompt prompt/docent.md` | 설치된 agents/videcoder-docent.md |
| 전사 | 서버가 jsonl 정규화해 대화 입력으로 (처음 한 번 + 이후 새 기록) | `history://<id>` 또는 정규화한 md 경로 |
| 출력 | 평문 → `slots.mjs` → 카드 | `{"answer": 평문}` |
| 도구 제한 | 설명은 `--tools read`, 분류는 도구 없음 (runner.mjs) | 프론트매터 `tools:` |

## 코어가 가정하는 것

- 과제에 **전사**(또는 전사 위치)와 **사용자 질문**이 들어 있다. 웹앱에서는 한 스레드가 이어지는 대화이고, 전사 갱신이 뒤에 이어 붙는다.
- 전사는 시간순으로 읽히는 텍스트다. 사용자 발화, 에이전트 발화, 도구 호출 요약, AI가 사용자에게 한 질문(질문 문장·선택지)과 `ask` 답이 구분된다.
- 읽기 도구만 있다. 쓰기·실행 도구는 없다(있어도 쓰지 않는다).

코어는 호스트·도구·경로 이름을 모른다. 이 셋은 모두 어댑터(웹앱 서버 또는 프론트매터)가 채운다.

## 세션 제공자

`app/server.mjs` 의 `providers` 배열. `jsonlProvider({id, root, depth, match, headBytes, meta, normalize, parse, events, stamp})` 로 만든다. 지금은 `omp`(`~/.omp/agent/sessions/*/*.jsonl`), `claude`(`~/.claude/projects/*/*.jsonl`, 서브에이전트 파일을 `stamp`로 캐시 기준에 포함), `codex`(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), `gemini`(`~/.gemini/tmp/*/chats/session-*.jsonl`, 작업 폴더는 `.project_root`), `pi`(`~/.pi/agent/sessions/*/*.jsonl`). 목록은 바뀐 파일의 머리만 다시 읽는다. 새 호스트는 정규화 함수 하나 + 항목 하나. 전사 출력 모양(`## user` / `## assistant` / `→ 도구(…) ⇒ ok·에러·사용자 답`, AI의 질문은 질문 문장·선택지 포함)은 호스트가 달라도 같아야 한다. 도슨트는 구분하지 않는다.

## 웹앱 요청 흐름

1. `GET /api/sessions` — 각 제공자의 세션 파일 머리만 읽어 제목·폴더·시각. 최신순 200개.
2. 프로필·세션을 고른다. 세션 목록은 최근 10개부터 보여 주고 "더 보기"로 늘린다. 세션을 고르면 작업 내용이 펼쳐지고, 카드를 누르면 그 카드의 대화 스레드가 열린다(ADR 0022). 스레드 식별자(`thread`)는 서버가 질문 대상 내용으로 발급하고, 대상이 없으면 `""`(세션 전체 대화)다. 즐겨찾기는 `GET/POST /api/favorites`로 프로필·세션·스레드별로 `learning.json`에 저장한다.
3. `POST /api/ask {id, question, profileId, difficulty?, requestId, auto?, focus?, cards?}` — 같은 requestId 작업이 진행 중이면 합류, 저장된 결과가 있으면 재생, 없으면 작업을 연다. 작업: 요청 시작 저장 → 깊이 결정(이번 질문 선택 > 분야별 설정이 있을 때만 짧은 분야 판정 > 프로필 기본값) → 스레드 대화에 전사(또는 갱신분)·기억 후보 요약·이번 질문 맥락을 보내 설명 스트림 → 이 대화에 실제로 보낸 근거만 검증 → 문답·요청 완료 저장(`learning.classification: "pending"`) → 답을 돌려준 뒤 뒤에서 학습 분류(질문·질문 대상·최근 대화·방금 한 답·카드 목록·기억 후보)를 붙이고 라이브 연결로 `{kind: "record"}`를 알린다 (ADR 0032). `Accept: application/x-ndjson`이면 `stage`·`delta`·`steer`·`reset`과 끝줄(`answer`·`error`·`cancelled`)을 줄 단위로 보낸다.
4. 설명 중 Esc/멈춤은 `POST /api/ask/cancel`(모델 호출을 끊고 문답을 남기지 않음, 요청은 `cancelled`), ⌘Enter/"지금 바로잡기"는 `POST /api/ask/steer`(같은 대화 맥락에서 다시 답함), Enter는 브라우저의 대기 질문. `GET /api/jobs`로 새로고침 뒤 진행 중 작업에 다시 붙는다 (ADR 0029).
5. 대화에는 짧은 결론과 핵심 설명을 먼저 그리고 세부 내용을 접어 둔다. "원문 보기"는 `/api/evidence`를 통해 원문 패널을 연다. 앱이 만든 요청문은 서버가 준 `display`로 보여 준다. 답의 `suggest`가 있으면 해당 카드 대화로 옮기기 버튼을 둔다.
6. 프로필/세션 전환 시 이전 응답을 새 화면에 반영하지 않는다. 같은 requestId의 재전송은 저장한 결과를 돌려주고, 새로운 의문은 새 ID로 다시 설명한다.

`GET /api/models`는 설치된 omp 카탈로그를 공개 필드만 골라 반환한다. 프로필의 `model`은 정확한 selector 또는 null이며, `PATCH /api/profiles/:id`로 저장한다. 새 설명 요청은 시작 시 이 값을 고정하고 분류·설명 모두 같은 provider/model로 호출한다. 명시적 모델 실행 실패는 기본 모델로 대체하지 않는다. `answer.model`은 요청 당시 선택값이며 실제 과금·호스트 내부 실행 계측값은 아니다. 가격은 USD/백만 토큰 참고값으로 입력·출력을 나눠 표시한다. 완료 요청 재전송은 이후 모델 설정이나 카탈로그가 바뀌어도 기존 답과 모델 선택을 유지한다.

## 라이브 흐름 (ADR 0006)

1. 세션을 고르면 페이지가 `GET /api/live?id=&profileId=` SSE 를 연다. 서버는 세션마다 감시기 하나를 두고 화면 구독과 미리 설명이 함께 쓴다. `profileId` 없는 구독(다른 컴퓨터의 docent)은 미리 설명을 예약하지 않는다.
2. `live.mjs` 가 먼저 파일 꼬리 512KB 에서 최근 이벤트 5개를 `past: true` 로 보내고(ADR 0012), 그 뒤 파일 끝에서 시작해 1초마다 새 바이트를 읽어 제공자의 `parse` → `events` 로 이벤트를 뽑는다. 카드 이벤트에는 서버가 만든 `focus`·`thread`와 미리 설명 상태(`ask`·`autoState`)가 붙는다.
3. 구조화된 질문은 바로 선별한다. 어시스턴트 발화는 Jev로 질문·결과·계획인지 판정한다. 진행 중계·도구 오류·종료 신호 자체는 카드로 보내지 않는다. 판정기가 없거나 실패하면 구조화 질문만 남기고 제한을 알린다.
4. 작업 내용 카드는 한 줄 요약 제목, 3문장 이내 요약, 상태로 이루어지고 원문은 접어 둔다. 요약은 준비된 설명의 결론과 핵심 설명 앞부분에서 만든다. 카드를 누르면 그 카드의 스레드가 열리며 모델 호출은 없다. 새 사건은 질문 대상·입력·읽던 위치를 바꾸지 않는다. 설명 생성과 근거 검증은 수동 질문과 같은 `/api/ask` 경로다.
5. `/api/ask`는 의미 분류의 질문 종류·개념·이해 대상·분야와 답·검증된 근거·용어·바로잡기를 현재 프로필에 저장한다. 미리 설명은 수동 반복 횟수나 이해 상태를 바꾸지 않는다. `GET /api/history?id=&profileId=`로 해당 로컬 프로필의 이전 문답을 읽는다(`thread`·`display` 포함).

## 배운 내용 다시보기 (ADR 0008·0017)

왼쪽 상단 책 아이콘 "배운 내용 다시보기"는 단어 중심 용어 사전이다 (ADR 0020). `GET /api/wiki?profileId=`가 문답마다 저장한 핵심 단어(`keywords`)를 모아 단어·한 줄 뜻·등장 횟수·관련 대화(답의 결론 한 줄)·첫 코드 블록을 돌려준다. 새 문답의 단어는 학습 분류 호출이 함께 뽑으므로 모델 호출이 늘지 않는다. 단어가 없는 옛 문답은 사용자가 "용어 정리"를 누를 때 `POST /api/wiki/extract`로 최대 30개를 모델 호출 한 번에 정리한다. 옛 `questions.jsonl` 줄의 단어는 원본을 고치지 않고 `learning.json`의 `legacyKeywords`에 둔다. 개념별 이해 상태는 설명 전략을 고르는 내부 기억이며 화면에 편집 UI를 두지 않는다(ADR 0021). `GET /api/learning`, `PATCH /api/learning/:id`는 API로만 남아 있다. 자주 묻는 질문 순위와 질문 종류 통계는 없앴다.

## 미리 설명 (ADR 0031)

프로필이 세션을 열면 서버가 12시간 동안 그 세션을 지켜보고, 탭을 닫아도 선별된 새 질문·결과·계획을 EASY로 미리 설명한다. requestId는 프로필·세션·스레드로 정해져 브라우저가 같은 요청으로 붙거나 저장된 답을 받는다. 켜기/끄기는 프로필 `autoExplain`(기본 켬), 상태는 `GET /api/prefetch`. 프로필마다 한 번에 하나, 10분에 5개까지이며, 사용자 질문이 진행 중이거나 막 끝났으면 기다린다. 과거 재생은 미리 설명하지 않는다. 미리 설명도 스레드 대화에 보이므로 이어 묻기 맥락에 들어간다.

## 속도 (ADR 0028·0030)

모든 omp 호출은 `runner.mjs`가 기억(recall·retain)·확장·스킬·규칙·LSP 탐색을 끄고 thinking을 명시해 실행한다(EASY·NORMAL=low, HARD=medium, 분류·용어 추출=off). 학습 분류는 설명이 끝난 뒤 돈다. 정규화 전사와 근거 표식은 파일 크기·수정 시각(Claude Code는 서브에이전트 파일 포함) 기준으로 캐시한다. 스레드 대화는 전사를 한 번만 보내고 이후에는 새 기록만 보낸다. 동시에 열린 대화는 최대 4개, 유휴 10분 뒤 닫는다.

## 다른 컴퓨터 (ADR 0011)

`~/.docent/config.json`의 `peers`마다 제공자가 붙는다. 원격 세션 ID는 `@이름/원래id`. 목록·전사·라이브를 원격에서 읽고 답변은 내 omp로 만든다. ADR 0014부터 원격 문답은 자동으로 합치지 않는다. 같은 프로필 ID가 같은 사람이라는 보장이 없기 때문이다. `--host tailscale`은 테일스케일 IPv4에도 열며 loopback은 유지한다.

## 개인화 저장과 PiP (ADR 0014)

`learning.json`의 문답 레코드가 답과 근거의 정본이다. 개념별 설명 이력과 완료 요청은 recordId를 참조한다. 임시 파일+fsync+rename으로 저장하며, 같은 폴더는 한 서버만 수정한다. 기존 `questions.jsonl`은 기본 프로필의 역사로만 읽는다. 프로필은 인증이 아닌 개인화 선택이다.

지원되는 보안 컨텍스트에서 Document PiP 창을 연다. 작은 창은 본문의 미니 버전이다: 작업 내용 카드 목록과 선택한 카드의 대화·입력창만 보이고 비중은 약 35:65다(좁으면 위/아래, 720px 이상이면 좌/우, ADR 0026). 본문과 같은 초안·스레드·답변 상태·요청 경로를 공유하고 별도 SSE나 모델 호출은 만들지 않는다. 원문 보기와 배운 내용 다시보기는 본문에서 연다. 부모 페이지가 닫히면 함께 닫히고, 미지원 브라우저에서는 사유만 안내한다. 투명도나 일반 팝업 대체는 없다.

## 표시와 빌드 (ADR 0015)

Streamdown·React는 Markdown 표시를 담당하며 나머지 페이지 상태는 기존 흐름을 유지한다. 설명·복습·PiP에 같은 렌더링 원칙을 적용한다. 표·목록·코드 블록은 슬롯 내부에서 구조를 보존한다. 긴 설명은 접거나 크게 열고, 근거 원문은 설명과 구별한다. 임의 HTML·실행 링크·추적 이미지를 차단한다.

`npm run build`로 로컬 자산을 만들고 `npm pack`의 prepack에서도 빌드한다. 서버는 정해진 자산 경로만 제공한다. 릴리스 패키지에 자산을 넣으므로 사용자 실행 시 빌드 도구나 CDN 접속이 필요하지 않다.

## 코어를 고칠 때

`prompt/docent.md` 만 고친다. 웹앱은 매 요청 파일을 읽으므로 재시작 불필요. 서브에이전트 경로는 `scripts/install-omp.sh` 재실행.
