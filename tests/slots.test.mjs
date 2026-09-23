import assert from "node:assert/strict";
import test from "node:test";
import { parseAnswer } from "../app/slots.mjs";

test("detail sections keep tables, ordered and nested lists, quotes, and code as one Markdown document", () => {
	const markdown = [
		"### 바뀐 흐름", "", "1. 입력을 확인해요.", "   - 빈 값은 보내지 않아요.", "     - 공백만 있는 값도 포함해요.",
		"   - 다음 문장은 목록 내용이에요.", "     이렇게 말하면 돼요:", "2. 확인된 값만 저장해요.", "",
		"| 조건 | 결과 |", "| --- | --- |", "| 빈 입력 | 안내 표시 |", "| 정상 입력 | 저장 |", "",
		"> 주의: 이전 값은 지우지 않아요.", ">", "> 실제 변경 범위만 설명해요.", "",
		"```js", "function save(value) {", "  return { value };", "}", "```",
	].join("\n");
	const answer = parseAnswer(`입력 확인이 생겼어요\n저장 전에 잘못된 값을 걸러요.\n\n기존 값은 그대로 남아요.\n더 자세히:\n${markdown}`);
	assert.equal(answer.headline, "입력 확인이 생겼어요");
	assert.equal(answer.explain, "저장 전에 잘못된 값을 걸러요.\n\n기존 값은 그대로 남아요.");
	assert.deepEqual(answer.details, [markdown]);
});

test("literal fences do not become slots or lose citations, while machine metadata stays hidden", () => {
	const code = [
		"````md", "더 자세히:", "이렇게 말하면 돼요:", "```text", "근거: [ref:literal]", "```", "<!-- docent-learning literal -->", "````",
		"", "> ~~~md", "> [ref:quoted-literal]", "> <!-- docent-source literal -->", "> ~~~",
	].join("\n");
	const answer = parseAnswer([
		"표식의 차이를 설명해요", "본문 근거[ref:hidden]와 `[ref:inline-literal]`은 달라요.",
		"<!-- docent-learning", "{\"private\": true}", "-->", "더 자세히:", code, "",
		"더 자세히:", "| 뜻 | 예 |", "| --- | --- |", "| 본문 | 확인됨[ref:table-hidden] |",
		"근거: [ref:footer-hidden]", "<!-- docent-source {\"private\":true} -->",
	].join("\n"));
	assert.equal(answer.explain, "본문 근거와 `[ref:inline-literal]`은 달라요.");
	assert.deepEqual(answer.details, [code, "| 뜻 | 예 |\n| --- | --- |\n| 본문 | 확인됨 |"]);
});
