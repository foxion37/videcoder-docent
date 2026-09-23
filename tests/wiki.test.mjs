import assert from "node:assert/strict";
import test from "node:test";
import { extractInput, parseExtract, parseKeywords, wiki } from "../app/wiki.mjs";

const row = (id, ts, keywords, raw = "✅ 결론\n설명") => ({ recordId: id, ts, sessionId: "s1", question: `질문 ${id}`, answer: { raw, headline: `결론 ${id}` }, ...(keywords ? { keywords } : {}) });

test("keywords merge case-insensitively, keep the newest gloss and count every mention", () => {
	const data = wiki([
		row("a", "2026-09-01", [{ term: "doppler", gloss: "옛 뜻" }]),
		row("b", "2026-09-02", [{ term: "Doppler", gloss: "새 뜻" }, { term: "PRD", gloss: "요구 문서" }], "```js\nconst a = 1;\n```"),
		row("c", "2026-09-03"),
	]);
	assert.equal(data.pending, 1);
	const doppler = data.entries.find((entry) => entry.term === "Doppler");
	assert.equal(doppler.count, 2);
	assert.equal(doppler.gloss, "새 뜻");
	assert.deepEqual(doppler.contexts.map((context) => context.id), ["b", "a"]);
	assert.equal(data.entries[0].term, "Doppler");
	assert.equal(data.entries.find((entry) => entry.term === "PRD").contexts[0].code.text, "const a = 1;");
	assert.deepEqual(Object.keys(data.answers).sort(), ["a", "b"]);
});

test("model keyword output is validated and extraction only accepts requested ids", () => {
	assert.deepEqual(parseKeywords([{ term: " API ", gloss: "프로그램끼리 대화하는 약속" }, { term: "api", gloss: "중복" }, { term: "", gloss: "x" }, "bad"]), [{ term: "API", gloss: "프로그램끼리 대화하는 약속" }]);
	assert.equal(parseKeywords("nope"), null);
	const { ids } = extractInput([row("x", "2026-09-01"), row("y", "2026-09-02", [])]);
	assert.deepEqual(ids, ["x"]);
	const result = parseExtract('{"items":[{"id":"x","keywords":[{"term":"token","gloss":"접근 열쇠"}]},{"id":"intruder","keywords":[{"term":"a","gloss":"b"}]}]}', ["x", "z"]);
	assert.deepEqual(result, { x: [{ term: "token", gloss: "접근 열쇠" }], z: [] });
});
