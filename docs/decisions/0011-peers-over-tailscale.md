# 0011 — 다른 컴퓨터의 세션: docent 끼리 테일스케일로 읽어 온다

Date: 2026-09-22
Status: Accepted

## Context

서로 다른 컴퓨터에서 에이전트를 돌리고, 기기끼리 사설망으로 묶어 주는 테일스케일을 사용하는 구성을 지원한다. 한 화면에서 두 컴퓨터의 세션을 다 보고 싶다. 세션 기록은 각 컴퓨터의 `~/.omp`, `~/.claude` 에 있고 ADR 0005·0007 은 "기록은 그 컴퓨터를 떠나지 않고, docent 는 127.0.0.1 에만 연다"로 정했다.

후보: A 파일 동기화(rsync/sshfs) — 수십 MB 파일을 계속 복사, 라이브 폴링이 원격 파일에 안 맞음 / B 원격 컴퓨터의 docent 를 세션 제공자로 삼아 HTTP 로 읽기 / C 중앙 서버 — 0007 에서 이미 배제.

## Decision

1. **B. 원격 docent 가 곧 제공자.** `app/peers.mjs` 의 `peerProvider(name, url)` 가 그쪽 `/api/sessions`·`/api/transcript`·`/api/live`·`/api/history` 를 그대로 받아 온다. 세션 id 는 `@<이름>/<원래 id>`, 목록 항목에 `host: "<이름>"`. 답은 **내 컴퓨터의 omp** 가 만든다(전사를 받아 와서). 문답은 내 `questions.jsonl` 에 남고, 그쪽에서 물어본 것도 `/api/history` 에 합쳐 보인다.
2. **설정은 `~/.docent/config.json`** `{"host": "tailscale", "peers": {"book": "http://peer-host.example:4747"}}`. CLI `--host`, `--peer 이름=URL` 이 우선. 환경변수 `DOCENT_HOST`, `DOCENT_PEERS` 도 같은 뜻.
3. **열어 주는 쪽은 `--host tailscale`.** 이 컴퓨터의 테일스케일 IPv4(`tailscale ip -4`)에 추가로 연다. 127.0.0.1 은 항상 연다(`docent` 명령의 "이미 켜져 있나" 확인이 거기를 본다). `0.0.0.0` 은 제공하지 않는다 — 집 LAN 에 인증 없이 열리는 걸 막는다.
4. **인증은 테일스케일이 한다.** docent 는 여전히 인증이 없다. 테일넷 밖에서는 닿지 않고, Funnel(공개 노출)에는 절대 올리지 않는다. README 에 명시.
5. 원격 목록을 못 받으면(꺼짐·오프라인) 그 컴퓨터 세션만 빠지고 나머지는 정상. 5초 타임아웃.

## Consequences

- (+) 코드 100줄, 새 의존성 없음. 양쪽에 docent 만 있으면 된다.
- (+) 기록 파일이 컴퓨터를 떠나지 않는다. 전사 텍스트만 질문할 때 잠깐 건너온다.
- (−) 양쪽 docent 버전이 같아야 한다(응답 모양이 계약). 오래된 쪽은 `first`·`host` 같은 새 필드가 없어 목록이 조금 빈약하다.
- (−) 원격 라이브는 HTTP 스트림 두 단을 거쳐 1~2초 늦다.
- (−) 원격 세션에 대한 문답 기억이 두 컴퓨터에 나뉜다. `/api/history` 가 합쳐 보이지만 복습 집계는 내 것만 센다.
- 영향 범위: `app/peers.mjs`(신규), `app/server.mjs`, `app/store.mjs`(config), `bin/docent.mjs`, `README.md`, `docs/architecture.md`
