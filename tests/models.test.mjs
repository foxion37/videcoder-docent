import assert from "node:assert/strict";
import test from "node:test";
import { catalog, firstModel, fixture as startFixture, secondModel, until } from "./omp-fixture.mjs";

/** 모델 호출 기록에서 이 테스트가 보는 필드만. */
async function fixture(t) {
	const f = await startFixture(t);
	const calls = f.calls.bind(f);
	f.calls = async () => (await calls()).map(({ planning, model, provider }) => ({ planning, model, provider }));
	return f;
}

const rows = async (f, profileId = "default") => (await f.api(`/api/history?profileId=${profileId}`)).body;

test("profile model selection is exact, isolated, snapshotted for the answer and its later classification, and replayed from history", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.api("/api/profiles")).body[0].model, null);
	const listed = await f.api("/api/models");
	assert.equal(listed.status, 200);
	assert.equal(listed.body.source, "omp");
	assert.deepEqual(listed.body.models, catalog.models.slice(0, 2).map(({ selector, provider, name, cost }) => ({ selector, provider, name, cost })));
	assert.equal(JSON.stringify(listed.body).includes("never-expose-catalog-secret"), false);
	const other = (await f.api("/api/profiles", "POST", { name: "Other profile" })).body;
	assert.equal((await f.api("/api/profiles/default", "PATCH", { model: firstModel })).status, 200);
	for (const invalid of ["cheap", "fixture/vendor/cheap ", "fixture/embed", 4]) {
		assert.equal((await f.api("/api/profiles/default", "PATCH", { model: invalid })).status, 400);
	}
	assert.equal((await f.api("/api/profiles")).body.find((p) => p.id === other.id).model, null);
	assert.equal((await f.api("/api/profiles")).body[0].model, firstModel);
	// 답은 분류를 기다리지 않는다. 분류는 요청 시작 때 고른 모델로 뒤에서 돈다.
	await f.control({ holdPlanning: true });
	const result = await f.ask("snapshot");
	assert.equal(result.status, 200);
	assert.equal(result.body.model, firstModel);
	await until(async () => (await f.calls()).some((call) => call.planning));
	assert.equal((await f.api("/api/profiles/default", "PATCH", { model: secondModel })).status, 200);
	await f.release();
	await until(async () => (await rows(f))[0]?.answer.learning.classification !== "pending");
	assert.deepEqual(await f.calls(), [
		{ planning: false, provider: "fixture", model: firstModel },
		{ planning: true, provider: "fixture", model: firstModel },
	]);
	await f.restart();
	assert.equal((await f.api("/api/profiles")).body[0].model, secondModel);
	// A stale/unavailable current catalog must not invalidate an already completed request.
	await f.catalog({ models: [] });
	const replay = await f.ask("snapshot");
	assert.equal(replay.body.recordId, result.body.recordId);
	assert.equal(replay.body.model, firstModel);
	assert.equal((await f.calls()).length, 2);
	assert.equal((await rows(f))[0].answer.model, firstModel);
	assert.deepEqual(await rows(f, other.id), []);
	const stored = await f.stored();
	assert.equal(Object.hasOwn(stored.requests["default:snapshot"], "answer"), false);
	assert.equal((await f.ask("unavailable")).status, 400);
	assert.equal((await f.calls()).length, 2);
});

test("a failed classification never blocks or reroutes the answer, and a failed explanation never falls back to another model", async (t) => {
	const f = await fixture(t);
	await f.api("/api/profiles/default", "PATCH", { model: firstModel });
	await f.control({ failPlanning: true });
	const answered = await f.ask("classification-failed");
	assert.equal(answered.status, 200);
	await until(async () => (await rows(f))[0]?.answer.learning.classification === "unknown");
	assert.match((await rows(f))[0].answer.learning.warning, /학습 분류/);
	assert.deepEqual(await f.calls(), [
		{ planning: false, model: firstModel, provider: "fixture" },
		{ planning: true, model: firstModel, provider: "fixture" },
	]);
	await f.control({ failExplanation: true });
	const failed = await f.ask("explanation-failed");
	assert.equal(failed.status, 502);
	assert.equal(JSON.stringify(failed.body).includes("never-expose-execution-secret"), false);
	assert.deepEqual((await f.calls()).slice(2), [{ planning: false, model: firstModel, provider: "fixture" }]);
	assert.equal((await rows(f)).length, 1);
	await f.api("/api/profiles/default", "PATCH", { model: null });
	assert.deepEqual(await f.ask("explanation-failed"), failed);
	assert.equal((await f.calls()).length, 3);
	await f.catalog({ error: "never-expose-catalog-secret" });
	const catalogFailure = await f.api("/api/models");
	assert.equal(catalogFailure.status, 502);
	assert.equal(JSON.stringify(catalogFailure.body).includes("never-expose-catalog-secret"), false);
});
