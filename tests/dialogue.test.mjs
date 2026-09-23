import assert from "node:assert/strict";
import test from "node:test";
import { dialogueContext, parseFocus, recentDialogue, threadRecords } from "../app/dialogue.mjs";

const record = (n, extra = {}) => ({ question: `질문 ${n}`, answer: { headline: `결론 ${n}`, explain: `설명 ${n}` }, ...extra });

test("follow-ups see the chosen focus and the latest six conversation turns, never automatic explanations", () => {
	const records = [
		...Array.from({ length: 7 }, (_, n) => record(n)),
		record("자동", { auto: true }),
		record("대상", { focus: { label: "로그인 방식 선택", text: "이메일과 소셜 중 선택" } }),
	];
	const recent = recentDialogue(records);
	assert.deepEqual(recent.map((turn) => turn.question), ["질문 2", "질문 3", "질문 4", "질문 5", "질문 6", "질문 대상"]);
	assert.equal(recent.at(-1).focus, "로그인 방식 선택");
	const focus = parseFocus({ label: " 로그인 방식 선택 ", text: "이메일과 소셜 로그인 중 무엇을 쓸까요?" });
	assert.deepEqual(focus, { label: "로그인 방식 선택", text: "이메일과 소셜 로그인 중 무엇을 쓸까요?" });
	const context = dialogueContext(focus, records);
	assert.match(context, /이메일과 소셜 로그인 중 무엇을 쓸까요\?/);
	assert.doesNotMatch(context, /질문 자동/);
	assert.match(dialogueContext(null, []), /세션 전체에 대한 질문/);
});

test("a malformed focus is rejected instead of silently asking about the whole session", () => {
	for (const invalid of [{}, { label: "제목" }, { label: "", text: "내용" }, { label: "x".repeat(201), text: "내용" }, { label: "제목", text: "x".repeat(8001) }, "제목"]) {
		assert.throws(() => parseFocus(invalid), { status: 400 });
	}
	assert.equal(parseFocus(undefined), null);
});

test("each card keeps its own conversation; whitespace differences stay in the same thread", () => {
	const card = { label: "로그인", text: "이메일과  소셜 중\n선택" };
	const records = [record("세션"), record("카드", { focus: { label: "로그인", text: "이메일과 소셜 중 선택" } }), record("다른 카드", { focus: { label: "배포", text: "배포 결과" } })];
	assert.deepEqual(threadRecords(records, card).map((r) => r.question), ["질문 카드"]);
	assert.deepEqual(threadRecords(records, null).map((r) => r.question), ["질문 세션"]);
});
