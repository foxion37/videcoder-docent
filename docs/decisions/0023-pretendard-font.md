# 0023 — 본문 글꼴 Pretendard를 패키지에 포함

Date: 2026-09-24
Status: Accepted

## Context

사용자가 글꼴을 Pretendard로 바꾸고 제목 굵기를 한 단계 낮추기를 원했다. ADR 0015에 따라 실행 중 CDN을 쓰지 않는다.

## Decision

- `pretendard` npm 패키지를 개발 의존성으로 두고, `npm run build`가 가변 글꼴 `PretendardVariable.woff2`(약 2MB)와 OFL 라이선스를 `app/assets/`로 복사한다. 서버는 정해진 자산 경로로만 제공하고 글꼴은 7일 캐시한다.
- 본문 글꼴은 Pretendard, 없으면 시스템 한글 글꼴로 대체한다. 작은 창은 같은 글꼴을 절대 주소로 불러온다.
- 제목 굵기는 650~700에서 600으로 낮춘다.

## Consequences

- 패키지가 약 2MB 커진다. 첫 화면에서 글꼴을 한 번 내려받는다.
- 영향 범위: `app/build.mjs`, `app/server.mjs`, `app/index.html`, `app/markdown.css`, `package.json`, `app/assets/`
