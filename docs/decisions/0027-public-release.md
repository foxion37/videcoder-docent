# 0027 — 공개 저장소와 GitHub Release 배포

Date: 2026-09-24
Status: Accepted. ADR 0007의 배포 채널(비공개 GitHub 설치, npm 공개 여부 미정)을 구체화한다.

## Context

다른 사람도 받아 쓸 수 있게 공개 저장소로 준비했다. 감사 결과 기존 히스토리에는 개인 세션으로 만든 평가 자료, 개인 기기 이름, 커밋 작성자 개인 메일이 남아 있었다.

## Decision

1. **새 히스토리로 공개한다.** 기존 저장소는 비공개 보관(`videcoder-docent-archive`)으로 두고, 정리한 파일로 첫 커밋을 만든 새 저장소를 `foxion37/videcoder-docent`로 쓴다. 작성자는 GitHub noreply 주소. 공개 전환은 저장소 주인이 확인 후 직접 한다.
2. **배포는 GitHub Release의 tgz.** `v*` 태그를 올리면 Actions가 테스트·빌드·패키징하고 `videcoder-docent-<version>.tgz`와 고정 이름 `videcoder-docent.tgz`를 첨부한다. 설치는 `npm install -g https://github.com/foxion37/videcoder-docent/releases/latest/download/videcoder-docent.tgz`. `package.json`의 `private: true`로 npm 레지스트리 게시는 막는다.
3. **런타임 의존성 0.** React·Streamdown은 빌드 때만 쓰고 `app/assets/`에 번들한다. 설치 시 추가 패키지를 받지 않는다. 번들에 들어간 코드와 Pretendard 글꼴의 라이선스는 `THIRD_PARTY_NOTICES.md`에 둔다.
4. **CI.** main push·PR마다 Node 22/24(Ubuntu), Node 22(macOS)에서 빌드 결과가 커밋된 `app/assets`와 같은지, 테스트, `npm pack`을 확인한다.
5. **공개 문서.** README(브랜드 썸네일, 가짜 데이터 스크린샷), LICENSE(MIT), SECURITY, CONTRIBUTING, 이슈·PR 템플릿. 실제 세션 기록으로 만든 평가 자료는 공개 저장소에 두지 않는다.

## Consequences

- 옛 커밋·브랜치·태그 링크는 공개 저장소에서 찾을 수 없다. 기록은 보관 저장소에 남는다.
- 저장소가 공개되기 전에는 설치 URL이 인증 없이 동작하지 않는다.
- 영향 범위: `.github/`, `package.json`, `package-lock.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `evals/`, `docs/`
