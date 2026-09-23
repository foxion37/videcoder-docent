# 0007 — 실행·배포: 로컬 CLI `docent`, npm 패키지로 배포

Date: 2026-09-21
Status: Accepted (배포 채널 공개 여부는 미정)

## Context

도슨트는 사용자 컴퓨터의 세션 기록(`~/.omp`, `~/.claude`)을 읽고 그 컴퓨터의 `omp` 를 불러 답한다. 중앙 서버에 올리면 기록 업로드·서버 쪽 모델 키·로그인이 필요해지고 "로컬·비밀 유지" 설계(ADR 0005)와 정반대가 된다. 따라서 배포 = 설치물 배포.

## Decision

1. **실행은 `docent` 한 명령.** `bin/docent.mjs`: 이미 켜져 있으면 브라우저만 열고, 아니면 서버를 띄우고 브라우저를 연다. `--no-open`, `--port`. omp 가 없으면 설치 안내 후 종료.
2. **문답 기억은 `~/.docent/questions.jsonl`** (`DOCENT_HOME` 으로 변경). 패키지 폴더 안에 쓰지 않는다 — 전역 설치 시 `node_modules` 에 데이터가 남는 것을 막는다.
3. **배포 단위는 npm 패키지 `videcoder-docent`.** `bin: docent`, `files` 로 `bin app prompt scripts adapters` 만, 의존성 0, `engines.node >= 22`. 설치: `npm i -g videcoder-docent` 또는 `npm i -g github:<owner>/videcoder-docent`.
4. **전제 조건은 둘: Node 22+, omp 설치·로그인.** 없는 사람을 위한 Anthropic API 직접 호출은 만들지 않는다(ADR 0005 유지). 수요가 확인되면 별도 ADR.
5. **omp 확장(마켓플레이스)은 npm 패키지 위의 얇은 껍데기**로 나중에. `/docent` 슬래시 명령이 `docent` CLI 를 부르는 정도.
6. 상시 실행(LaunchAgent)은 만들지 않는다. 필요할 때 `docent` 를 치는 것으로 충분하다. 상시 실행이 필요하면 사용자가 자기 환경의 서비스 관리자로 등록한다.

## Consequences

- (+) 개발자든 아니든 "터미널에 `docent`" 한 줄.
- (+) 패키지 18KB, 빌드 없음, 의존성 없음 — 설치 실패 요인이 거의 없다.
- (−) omp 없는 사용자는 못 쓴다. README 첫 줄에 명시.
- (−) 공개 npm 에 올리면 이름이 굳는다. 비공개(GitHub 설치)로 시작할지, 공개할지는 사용자 결정.
- 영향 범위: `bin/docent.mjs`, `app/store.mjs`, `app/server.mjs`(브라우저 열기), `package.json`, `README.md`
