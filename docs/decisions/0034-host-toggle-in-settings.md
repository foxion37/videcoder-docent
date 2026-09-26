# 0034 — 테일스케일 공유는 설정창에서 켜고 끈다

Date: 2026-09-26
Status: Accepted

## Context

ADR 0011 은 열어 주는 쪽을 `--host tailscale` 이나 config.json `host: "tailscale"` 로 서버를 시작할 때 정했다. 상태를 바꾸려면 서버를 다시 시작해야 하고, 설정이 화면에 보이지 않아 다른 기기에서 접속하려고 할 때마다 터미널을 열어야 한다.

후보: A 시작 플래그만 유지 / B 설정창 스위치로 실행 중에도 켜고 끈다.

## Decision

1. **B. 설정창 "다른 기기에서 열기"에서 켜고 끈다.** `POST /api/host {tailscale: 참/거짓}` 이 테일스케일 IPv4 대기를 실행 중에 열고 닫는다. `GET /api/host` 가 현재 상태와 다른 기기용 주소를 돌려준다.
2. **127.0.0.1 은 항상 연다.** 테일스케일 공유를 꺼도 이 컴퓨터의 `docent` 명령과 지금 창은 그대로다.
3. **상태는 config.json 의 `tailscale` 참/거짓에 저장한다.** 옛 `host: "tailscale"` 은 스위치를 처음 저장할 때 `host: "127.0.0.1"` 과 `tailscale: 참` 으로 옮겨 둔다. 시작할 때는 `tailscale` 이 참이면 테일스케일 주소를 추가로 열고, 주소를 못 찾으면 경고만 하고 loopback 으로 뜬다. CLI `--host` 와 환경변수 `DOCENT_HOST` 가 최우선이다(ADR 0011).
4. **0.0.0.0 은 여전히 열지 않는다.** 인증은 테일스케일이 하고, Funnel 에는 올리지 않는다 (ADR 0011).

## Consequences

- (+) 다른 기기에서 접속할지 말지를 터미널 없이 정할 수 있다.
- (+) 시작할 때 테일스케일이 꺼져 있어도 서버는 뜬다. 다만 옛 `host: "tailscale"` 로 직접 시작한 경우는 기존대로 시작이 멈춘다.
- (−) 화면의 스위치가 서버의 네트워크 대기를 바꾼다. docent 는 여전히 인증이 없으므로 화면과 서버의 신뢰 범위가 같다는 전제가 더 중요해진다.
- 영향 범위: `app/server.mjs`, `app/store.mjs`(config 저장), `app/index.html`(설정창), `docs/architecture.md`
