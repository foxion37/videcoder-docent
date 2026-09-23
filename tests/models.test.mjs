import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const firstModel = "fixture/vendor/cheap";
const secondModel = "fixture/other";
const catalog = { models: [
	{ kind: "chat", provider: "fixture", id: "vendor/cheap", selector: firstModel, name: "Cheap", cost: { input: 0.15, output: 0.6, cacheRead: 0.003 }, apiKey: "never-expose-catalog-secret" },
	{ kind: "chat", provider: "fixture", id: "other", selector: secondModel, name: "Other", cost: { input: 0, output: 0 } },
	{ kind: "embedding", provider: "fixture", id: "embed", selector: "fixture/embed", name: "Embedding", cost: { input: 1, output: 1 } },
] };

async function until(check) {
	const deadline = Date.now() + 5000;
	while (!await check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for model fixture");
		await delay(10);
	}
}

async function fixture(t) {
	const home = await mkdtemp(join(tmpdir(), "docent-model-test-"));
	const stateHome = join(home, "state");
	const executable = join(home, "omp.mjs");
	const catalogFile = join(home, "catalog.json");
	const controlFile = join(home, "control.json");
	const logFile = join(home, "calls.jsonl");
	const releaseFile = join(home, "release");
	const sessionId = "claude:project/session.jsonl";
	await mkdir(join(home, ".claude/projects/project"), { recursive: true });
	await mkdir(stateHome);
	// Pre-model preferences must normalize without migrating or discarding old records.
	await writeFile(join(stateHome, "learning.json"), JSON.stringify({ version: 1, profiles: [{ id: "default", name: "기본", defaultDifficulty: "NORMAL", domainDifficulties: {} }], items: [], records: [], requests: {} }));
	await writeFile(join(home, ".claude/projects/project/session.jsonl"), JSON.stringify({ type: "user", cwd: "/project", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "검색 상태를 설명해줘" } }) + "\n");
	await writeFile(catalogFile, JSON.stringify(catalog));
	await writeFile(controlFile, "{}");
	await writeFile(logFile, "");
	await writeFile(executable, `#!${process.execPath}
import { appendFile, readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
if (args[0] === 'models') {
	process.stdout.write(await readFile(${JSON.stringify(catalogFile)}, 'utf8'));
} else {
	const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
	const planning = flag('--system-prompt').endsWith('learning-planner.txt');
	const model = flag('--model');
	const control = JSON.parse(await readFile(${JSON.stringify(controlFile)}, 'utf8'));
	await appendFile(${JSON.stringify(logFile)}, JSON.stringify({ planning, model, provider: flag('--provider') }) + '\\n');
	if (planning && control.holdPlanning) {
		const deadline = Date.now() + 10000;
		while (!await stat(${JSON.stringify(releaseFile)}).catch(() => null)) {
			if (Date.now() > deadline) process.exit(3);
			await delay(10);
		}
	}
	if ((planning && control.failPlanning) || (!planning && control.failExplanation)) {
		process.stderr.write('never-expose-execution-secret');
		process.exit(2);
	}
	console.log(planning ? JSON.stringify({ kind: 'why', domains: [], concepts: [] }) : '# ' + (model ?? 'default') + '\\n\\n설명 깊이와 출력을 줄이지 않은 답변입니다.');
}
`, { mode: 0o700 });
	let server;
	let address;
	async function stop() {
		if (!server || server.exitCode !== null || server.signalCode !== null) return;
		const exit = once(server, "exit");
		server.kill("SIGTERM");
		await exit;
	}
	async function start() {
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const port = reservation.address().port;
		await new Promise((resolve) => reservation.close(resolve));
		address = `http://127.0.0.1:${port}`;
		server = spawn(process.execPath, [join(root, "app/server.mjs")], { cwd: root, env: { ...process.env, HOME: home, DOCENT_HOME: stateHome, DOCENT_HOST: "127.0.0.1", DOCENT_PORT: String(port), DOCENT_PEERS: "", DOCENT_ON_LISTEN: "", TYPESAFE_API_KEY: "", OMP_BIN: executable }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let startupError;
		server.on("error", (error) => { startupError = error; });
		server.stdout.on("data", (chunk) => { output += chunk; });
		server.stderr.resume();
		await until(() => {
			if (startupError) throw startupError;
			if (server.exitCode !== null) throw new Error("Fixture server exited before listening");
			return output.includes(`docent: ${address}/`);
		});
	}
	t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
	await start();
	return {
		async api(path, method = "GET", value) {
			const response = await fetch(address + path, { method, ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) });
			return { status: response.status, body: await response.json() };
		},
		ask(requestId, profileId = "default") { return this.api("/api/ask", "POST", { id: sessionId, question: "왜 이렇게 했어?", requestId, profileId }); },
		async calls() { return (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
		control(value) { return writeFile(controlFile, JSON.stringify(value)); },
		release() { return writeFile(releaseFile, "ready"); },
		catalog(value) { return writeFile(catalogFile, JSON.stringify(value)); },
		stored() { return readFile(join(stateHome, "learning.json"), "utf8").then(JSON.parse); },
		async restart() { await stop(); await start(); },
	};
}

test("profile model selection is exact, isolated, snapshotted for both calls, and replayed from history", async (t) => {
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
	await f.control({ holdPlanning: true });
	const pending = f.ask("snapshot");
	await until(async () => (await f.calls()).some((call) => call.planning));
	assert.equal((await f.api("/api/profiles/default", "PATCH", { model: secondModel })).status, 200);
	await f.release();
	const result = await pending;
	assert.equal(result.status, 200);
	assert.equal(result.body.model, firstModel);
	assert.deepEqual(await f.calls(), [
		{ planning: true, provider: "fixture", model: firstModel },
		{ planning: false, provider: "fixture", model: firstModel },
	]);
	await f.restart();
	assert.equal((await f.api("/api/profiles")).body[0].model, secondModel);
	// A stale/unavailable current catalog must not invalidate an already completed request.
	await f.catalog({ models: [] });
	assert.deepEqual(await f.ask("snapshot"), result);
	assert.equal((await f.calls()).length, 2);
	const records = (await f.api("/api/history?profileId=default")).body;
	assert.equal(records[0].answer.model, firstModel);
	assert.deepEqual((await f.api(`/api/history?profileId=${other.id}`)).body, []);
	const stored = await f.stored();
	assert.equal(Object.hasOwn(stored.requests["default:snapshot"], "answer"), false);
	assert.equal((await f.ask("unavailable")).status, 400);
	assert.equal((await f.calls()).length, 2);
});

test("explicit model execution failures never fall back, but the unselected default keeps its planning fallback", async (t) => {
	const f = await fixture(t);
	await f.api("/api/profiles/default", "PATCH", { model: firstModel });
	await f.control({ failPlanning: true });
	const failed = await f.ask("planning-failed");
	assert.equal(failed.status, 502);
	assert.equal(JSON.stringify(failed.body).includes("never-expose-execution-secret"), false);
	assert.deepEqual(await f.calls(), [{ planning: true, model: firstModel, provider: "fixture" }]);
	await f.control({ failExplanation: true });
	assert.equal((await f.ask("explanation-failed")).status, 502);
	assert.deepEqual((await f.calls()).slice(1), [
		{ planning: true, model: firstModel, provider: "fixture" },
		{ planning: false, model: firstModel, provider: "fixture" },
	]);
	assert.deepEqual((await f.api("/api/history")).body, []);
	await f.api("/api/profiles/default", "PATCH", { model: null });
	assert.deepEqual(await f.ask("planning-failed"), failed);
	assert.equal((await f.calls()).length, 3);
	await f.control({ failPlanning: true });
	const defaultResult = await f.ask("default-fallback");
	assert.equal(defaultResult.status, 200);
	assert.equal(defaultResult.body.model, null);
	assert.deepEqual((await f.calls()).slice(3), [
		{ planning: true, model: null, provider: null },
		{ planning: false, model: null, provider: null },
	]);
	await f.catalog({ error: "never-expose-catalog-secret" });
	const catalogFailure = await f.api("/api/models");
	assert.equal(catalogFailure.status, 502);
	assert.equal(JSON.stringify(catalogFailure.body).includes("never-expose-catalog-secret"), false);
});
