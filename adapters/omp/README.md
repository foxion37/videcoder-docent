# omp 어댑터

## 설치

```sh
scripts/install-omp.sh            # → ~/.omp/agent/agents/videcoder-docent.md
scripts/install-omp.sh --project  # → ./.omp/agents/videcoder-docent.md (현재 폴더에서만)
```

`frontmatter.md` + `../../prompt/docent.md` 를 이어 붙인다. 코어를 고치면 다시 실행.

## 호출

메인 에이전트가 `task` 로 스폰한다. 지시문에 전사 위치와 질문을 넣는다.

```json
{
  "context": "바이브코더가 도슨트에게 묻는다.",
  "tasks": [{
    "agent": "videcoder-docent",
    "task": "전사: history://Main\n질문: 지금 뭐 한 거야?"
  }]
}
```

## 도구 제한

`tools: read, grep, glob` — 쓰기·실행 도구가 스폰 시점에 제거된다. 프롬프트의 "코드 안 만짐" 규칙을 호스트 수준에서도 강제한다.

`read-summarize: false` — `read` 가 파일 구조 요약 대신 원문을 돌려준다. 도슨트는 코드 구조가 아니라 내용을 봐야 한다.

## 결과 형태

omp 는 서브에이전트 결과를 `{"answer": "..."}` 로 감싸 돌려준다(구조화 yield). 코어 프롬프트와 무관한 호스트 동작. 메인 에이전트는 `answer` 값만 사용자에게 그대로 전달한다.
