import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "docent-learning-test-"));
process.env.DOCENT_HOME = home;
const learning = await import("../app/learning.mjs");
const { history } = await import("../app/store.mjs");
const source = { sessionId: "claude:project/test.jsonl", project: "project:local:/project", fingerprint: "source-version", cwd: "/project" };
const answer = { raw: "답변", headline: "답변", difficulty: "HARD", citations: [] };

const classify = (context, priorId = null, relation = "same-incident") => learning.parsePlan(JSON.stringify({
	kind: "why", domains: ["frontend"], concepts: [{ concept: "검색 상태", scope: "general", targets: ["code"], domains: ["frontend"], doubt: "왜 검색 중 버튼을 막는가", priorId, sameDoubt: Boolean(priorId), relation, strategy: "단계 추적" }],
}), context);

test("learning preserves profile isolation, explicit feedback, repeat and retry boundaries", async () => {
	try {
		const alice = await learning.createProfile("Alice");
		const bob = await learning.createProfile("Bob");
		await learning.updateProfile(alice.id, { defaultDifficulty: "NORMAL", domainDifficulties: { frontend: "HARD" } });
		const context = await learning.planningContext(alice.id, source, "왜 막아?", false);
		assert.equal(learning.resolveDifficulty(context.profile, ["frontend"]).difficulty, "HARD");
		assert.equal(learning.resolveDifficulty(context.profile, ["frontend"], "EASY").difficulty, "EASY");
		assert.equal(learning.resolveDifficulty({ defaultDifficulty: "HARD", domainDifficulties: { frontend: "EASY" } }, ["frontend"]).difficulty, "HARD");
		const plan = classify(context);
		const titled = (title) => learning.parsePlan(JSON.stringify({ kind: "why", domains: [], concepts: [], keywords: [], title }), context).title;
		assert.equal(titled("  로그인 방식 선택 "), "로그인 방식 선택");
		assert.equal(titled("x".repeat(41)), "");
		assert.equal(titled(3), "");
		let invocations = 0;
		const generate = async (request) => { invocations++; return learning.completeLearning(request, context, plan, answer, { kind: "why" }); };
		const [first, duplicate] = await Promise.all([
			learning.idempotentAsk(alice.id, "first", { question: context.question }, generate),
			learning.idempotentAsk(alice.id, "first", { question: context.question }, generate),
		]);
		assert.equal(invocations, 1);
		assert.equal(first.recordId, duplicate.recordId);
		const id = first.learning.concepts[0].id;
		assert.deepEqual(await learning.learningItems(bob.id), []);
		assert.deepEqual(await history(undefined, bob.id), []);
		await assert.rejects(learning.feedback(id, bob.id, "understood"), { status: 404 });
		await learning.feedback(id, alice.id, "understood", "");

		const repeatContext = await learning.planningContext(alice.id, source, "다시 설명해줘", false);
		const repeatPlan = classify(repeatContext, id);
		const repeated = await learning.idempotentAsk(alice.id, "repeat", {}, (request) => learning.completeLearning(request, repeatContext, repeatPlan, answer, { kind: "why" }));
		assert.equal(repeated.learning.repeated, true);
		assert.equal(repeated.learning.concepts[0].status, "unresolved");
		assert.notEqual(repeatPlan.concepts[0].strategy, plan.concepts[0].strategy);

		await learning.feedback(id, alice.id, "understood", "理解できた");
		const autoContext = await learning.planningContext(alice.id, source, "自動説明", true);
		const autoPlan = classify(autoContext, id);
		const automatic = await learning.idempotentAsk(alice.id, "auto", {}, (request) => learning.completeLearning(request, autoContext, autoPlan, answer, { kind: "why" }));
		assert.equal(automatic.learning.repeated, false);
		assert.equal(automatic.learning.concepts[0].status, "understood");
		const item = (await learning.learningItems(alice.id))[0];
		assert.equal(item.questionCount, 2);
		assert.equal(item.autoCount, 1);
		assert.equal(item.explanations.length, 3);
		assert.equal(item.explanations[0].explanation, answer.raw);

		const newContext = await learning.planningContext(alice.id, { ...source, fingerprint: "new-incident" }, "別の障害", false);
		const newPlan = classify(newContext, id, "new-incident");
		const fresh = await learning.idempotentAsk(alice.id, "new-incident", {}, (request) => learning.completeLearning(request, newContext, newPlan, answer, { kind: "why" }));
		assert.equal(fresh.learning.repeated, false);

		const pendingContext = await learning.planningContext(alice.id, source, "再説明", false);
		const pendingPlan = classify(pendingContext, id);
		await learning.idempotentAsk(alice.id, "feedback-during-answer", {}, async (request) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await learning.feedback(id, alice.id, "review", "後で復習");
			return learning.completeLearning(request, pendingContext, pendingPlan, answer, { kind: "why" });
		});
		assert.equal((await learning.learningItems(alice.id))[0].status, "review");
		await assert.rejects(learning.idempotentAsk(alice.id, "first", { question: "changed" }, generate), { status: 409 });
		const replay = await learning.idempotentAsk(alice.id, "first", { question: context.question }, generate);
		assert.equal(replay.recordId, first.recordId);
		assert.equal(invocations, 1);
		const unknown = learning.parsePlan('{"kind":"why","domains":["frontend"],"concepts":[{"priorId":"someone-else"}]}', context);
		assert.equal(unknown.classification, "unknown");
		assert.deepEqual(unknown.concepts, []);
		const stored = JSON.parse(await readFile(join(home, "learning.json"), "utf8"));
		assert.equal(stored.records.length, 5);
		assert.ok(Object.values(stored.requests).every((request) => !Object.hasOwn(request, "answer")));
		assert.ok(stored.items.every((value) => value.explanations.every((entry) => !Object.hasOwn(entry, "explanation") && !Object.hasOwn(entry, "evidence"))));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
